/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { HubSpotOAuthService } from './hubspot-oauth.service';

export interface HubSpotDealRecord {
  id: string;
  dealname: string;
  dealstage: string;
  pipeline: string;
  amount: string | null;
  closedate: string | null;
  hs_is_closed: boolean;
  lastActivityAt: string; // Resolved from notes_last_updated or hs_lastmodifieddate
}

//HubSpot v4 default association type IDs
const HS_ASSOC = {
  NOTE_TO_DEAL: 214,
  NOTE_TO_CONTACT: 202,
  NOTE_TO_COMPANY: 190,
  TASK_TO_DEAL: 216,
  TASK_TO_CONTACT: 204,
  TASK_TO_COMPANY: 192,
} as const;

export interface AssociationTargets {
  dealId: string;
  contactIds?: string[];
  companyId?: string | null;
}

export interface CreateNoteInput {
  bodyHtml: string;
  ownerId?: string | null;
  timestampIso: string;
  targets: AssociationTargets;
}

export interface CreateTaskInput {
  subject: string;
  bodyText: string;
  dueDateIso: string;
  ownerId?: string | null;
  targets: AssociationTargets;
}
export interface HubSpotOpenTask {
  id: string;
  subject: string;
  status: string;
}

export interface PipelineStageConfig {
  id: string;
  label: string;
  displayOrder: number;
  isClosed: boolean;
  requiredProperties: string[];
}

export interface OrgPipelineConfig {
  pipelines: Record<
    string,
    {
      id: string;
      label: string;
      stages: PipelineStageConfig[];
    }
  >;
}

@Injectable()
export class HubSpotService {
  private readonly logger = new Logger(HubSpotService.name);
  private readonly baseUrl = 'https://api.hubapi.com';

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: HubSpotOAuthService,
  ) {}

  /**
   * Rate-limit-aware HTTP wrapper with Retry-After support and exponential backoff + jitter
   */
  async request<T>(
    orgId: string,
    config: AxiosRequestConfig,
    maxRetries = 4,
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const token = await this.oauth.getValidAccessToken(orgId);

      try {
        const res = await axios.request<T>({
          ...config,
          baseURL: this.baseUrl,
          headers: {
            ...config.headers,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        });
        return res.data;
      } catch (err) {
        const axiosErr = err as AxiosError;
        const status = axiosErr.response?.status;

        // If 401, force expire the cached token timestamp so next iteration refreshes
        if (status === 401 && attempt < maxRetries) {
          await this.prisma.org.update({
            where: { id: orgId },
            data: { hubspotTokenExpiresAt: new Date(0) },
          });
          continue;
        }

        // Retry on 429 Too Many Requests or 5xx transient errors
        const isRetryable =
          status === 429 || (status !== undefined && status >= 500);
        if (!isRetryable || attempt === maxRetries) {
          throw err;
        }

        const retryAfterHeader = axiosErr.response?.headers?.['retry-after'];
        const baseDelayMs = retryAfterHeader
          ? parseInt(String(retryAfterHeader), 10) * 1000
          : Math.min(1000 * Math.pow(2, attempt), 10_000);
        const jitterMs = Math.floor(Math.random() * 400);

        this.logger.warn({
          msg: 'HubSpot API rate limit or 5xx encountered; backing off',
          orgId,
          status,
          attempt: attempt + 1,
          waitMs: baseDelayMs + jitterMs,
        });

        await new Promise((r) => setTimeout(r, baseDelayMs + jitterMs));
      }
    }

    throw new Error('Exhausted HubSpot API retries');
  }

  async getOpenTasksForDeal(
    orgId: string,
    dealId: string,
  ): Promise<HubSpotOpenTask[]> {
    // 1. Read associated task IDs via v4 Associations API
    const assocData = await this.request<{
      results: Array<{ to: Array<{ toObjectId: number }> }>;
    }>(orgId, {
      method: 'POST',
      url: '/crm/v4/associations/deals/tasks/batch/read',
      data: { inputs: [{ id: dealId }] },
    });

    const taskIds = Array.from(
      new Set(
        (assocData.results || []).flatMap((r) =>
          (r.to || []).map((t) => String(t.toObjectId)),
        ),
      ),
    );

    if (taskIds.length === 0) return [];

    // 2. Batch read task properties and filter out COMPLETED tasks
    const tasksData = await this.request<{
      results: Array<{
        id: string;
        properties: { hs_task_subject?: string; hs_task_status?: string };
      }>;
    }>(orgId, {
      method: 'POST',
      url: '/crm/v3/objects/tasks/batch/read',
      data: {
        inputs: taskIds.map((id) => ({ id })),
        properties: ['hs_task_subject', 'hs_task_status'],
      },
    });

    return (tasksData.results || [])
      .filter((t) => t.properties.hs_task_status !== 'COMPLETED')
      .map((t) => ({
        id: t.id,
        subject: t.properties.hs_task_subject || '',
        status: t.properties.hs_task_status || 'NOT_STARTED',
      }));
  }

  /**
   * 1. Syncs HubSpot Owners to User.hubspotOwnerId by matching email addresses
   */
  async syncOwners(orgId: string): Promise<number> {
    const data = await this.request<{
      results: Array<{ id: string; email?: string }>;
    }>(orgId, {
      method: 'GET',
      url: '/crm/v3/owners',
      params: { limit: 500 },
    });

    let matchedCount = 0;
    for (const owner of data.results) {
      if (!owner.email) continue;
      const res = await this.prisma.user.updateMany({
        where: { orgId, email: owner.email.toLowerCase().trim() },
        data: { hubspotOwnerId: owner.id },
      });
      matchedCount += res.count;
    }

    this.logger.log({ msg: 'Synced HubSpot owners', orgId, matchedCount });
    return matchedCount;
  }

  /**
   * 2. Syncs Deal Pipelines, stage order, closed flags, and required stage properties
   */
  async syncDealPipelines(orgId: string): Promise<OrgPipelineConfig> {
    const data = await this.request<{
      results: Array<{
        id: string;
        label: string;
        stages: Array<{
          id: string;
          label: string;
          displayOrder: number;
          metadata?: { isClosed?: string; requiredProperties?: string };
        }>;
      }>;
    }>(orgId, {
      method: 'GET',
      url: '/crm/v3/pipelines/deals',
    });

    const config: OrgPipelineConfig = { pipelines: {} };

    for (const pipeline of data.results) {
      const stages: PipelineStageConfig[] = pipeline.stages
        .map((s) => ({
          id: s.id,
          label: s.label,
          displayOrder: s.displayOrder,
          isClosed: s.metadata?.isClosed === 'true',
          requiredProperties: s.metadata?.requiredProperties
            ? s.metadata.requiredProperties
                .split(',')
                .map((p) => p.trim())
                .filter(Boolean)
            : [],
        }))
        .sort((a, b) => a.displayOrder - b.displayOrder);

      config.pipelines[pipeline.id] = {
        id: pipeline.id,
        label: pipeline.label,
        stages,
      };
    }

    await this.prisma.org.update({
      where: { id: orgId },
      data: { pipelineConfig: config as unknown as Prisma.InputJsonValue },
    });

    return config;
  }

  /**
   * 3. Searches Contacts by exact email match
   */
  async findContactsByEmails(
    orgId: string,
    emails: string[],
  ): Promise<Array<{ id: string; email: string }>> {
    if (emails.length === 0) return [];

    const data = await this.request<{
      results: Array<{ id: string; properties: { email?: string } }>;
    }>(orgId, {
      method: 'POST',
      url: '/crm/v3/objects/contacts/search',
      data: {
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'email',
                operator: 'IN',
                values: emails.map((e) => e.toLowerCase()),
              },
            ],
          },
        ],
        properties: ['email', 'firstname', 'lastname'],
        limit: 50,
      },
    });

    return data.results.map((r) => ({
      id: r.id,
      email: (r.properties.email || '').toLowerCase(),
    }));
  }

  /**
   * 4. Searches Companies by exact domain match
   */
  async findCompaniesByDomains(
    orgId: string,
    domains: string[],
  ): Promise<Array<{ id: string; domain: string; name: string }>> {
    if (domains.length === 0) return [];

    const data = await this.request<{
      results: Array<{
        id: string;
        properties: { domain?: string; name?: string };
      }>;
    }>(orgId, {
      method: 'POST',
      url: '/crm/v3/objects/companies/search',
      data: {
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'domain',
                operator: 'IN',
                values: domains.map((d) => d.toLowerCase()),
              },
            ],
          },
        ],
        properties: ['domain', 'name'],
        limit: 50,
      },
    });

    return data.results.map((r) => ({
      id: r.id,
      domain: (r.properties.domain || '').toLowerCase(),
      name: r.properties.name || '',
    }));
  }

  /**
   * 5. Queries HubSpot v4 Associations API to retrieve ALL primary and secondary deal IDs
   *    linked to a group of contacts or companies
   */
  async getAssociatedDealIds(
    orgId: string,
    fromObjectType: 'contacts' | 'companies',
    objectIds: string[],
  ): Promise<string[]> {
    if (objectIds.length === 0) return [];

    const data = await this.request<{
      results: Array<{
        from: { id: string };
        to: Array<{ toObjectId: number }>;
      }>;
    }>(orgId, {
      method: 'POST',
      url: `/crm/v4/associations/${fromObjectType}/deals/batch/read`,
      data: {
        inputs: objectIds.map((id) => ({ id })),
      },
    });

    const dealIds = new Set<string>();
    for (const row of data.results || []) {
      for (const target of row.to || []) {
        dealIds.add(String(target.toObjectId));
      }
    }

    return Array.from(dealIds);
  }

  /**
   * 6. Batch reads full Deal records by ID and filters/enriches activity timestamps
   */
  async getDealsByIds(
    orgId: string,
    dealIds: string[],
  ): Promise<HubSpotDealRecord[]> {
    if (dealIds.length === 0) return [];

    const data = await this.request<{
      results: Array<{
        id: string;
        properties: Record<string, string | null>;
      }>;
    }>(orgId, {
      method: 'POST',
      url: '/crm/v3/objects/deals/batch/read',
      data: {
        inputs: dealIds.map((id) => ({ id })),
        properties: [
          'dealname',
          'dealstage',
          'pipeline',
          'amount',
          'closedate',
          'hs_is_closed',
          'notes_last_updated',
          'hs_lastmodifieddate',
        ],
      },
    });

    return (data.results || []).map((d) => ({
      id: d.id,
      dealname: d.properties.dealname || 'Untitled Deal',
      dealstage: d.properties.dealstage || '',
      pipeline: d.properties.pipeline || 'default',
      amount: d.properties.amount ?? null,
      closedate: d.properties.closedate ?? null,
      hs_is_closed: d.properties.hs_is_closed === 'true',
      lastActivityAt:
        d.properties.notes_last_updated ||
        d.properties.hs_lastmodifieddate ||
        new Date(0).toISOString(),
    }));
  }

  /**
   * 7. Searches open deals by title keyword (Used only for Step 3 weak-signal fallback)
   */
  async searchOpenDealsByKeyword(
    orgId: string,
    keyword: string,
  ): Promise<HubSpotDealRecord[]> {
    const clean = keyword.trim();
    if (clean.length < 3) return [];

    const data = await this.request<{
      results: Array<{
        id: string;
        properties: Record<string, string | null>;
      }>;
    }>(orgId, {
      method: 'POST',
      url: '/crm/v3/objects/deals/search',
      data: {
        query: clean,
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'hs_is_closed',
                operator: 'NEQ',
                value: 'true',
              },
            ],
          },
        ],
        properties: [
          'dealname',
          'dealstage',
          'pipeline',
          'amount',
          'closedate',
          'hs_is_closed',
          'notes_last_updated',
          'hs_lastmodifieddate',
        ],
        limit: 10,
      },
    });

    return (data.results || []).map((d) => ({
      id: d.id,
      dealname: d.properties.dealname || 'Untitled Deal',
      dealstage: d.properties.dealstage || '',
      pipeline: d.properties.pipeline || 'default',
      amount: d.properties.amount ?? null,
      closedate: d.properties.closedate ?? null,
      hs_is_closed: false,
      lastActivityAt:
        d.properties.notes_last_updated ||
        d.properties.hs_lastmodifieddate ||
        new Date(0).toISOString(),
    }));
  }
  async getDealProperties(
    orgId: string,
    dealId: string,
    properties: string[],
  ): Promise<Record<string, string | null>> {
    const uniqueProps = Array.from(
      new Set([
        'dealname',
        'dealstage',
        'pipeline',
        'hs_next_step',
        ...properties,
      ]),
    );

    const data = await this.request<{
      id: string;
      properties: Record<string, string | null>;
    }>(orgId, {
      method: 'GET',
      url: `/crm/v3/objects/deals/${dealId}`,
      params: { properties: uniqueProps.join(',') },
    });

    return data.properties;
  }

  async updateDealProperties(
    orgId: string,
    dealId: string,
    properties: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    const serialized: Record<string, string> = {};
    for (const [k, v] of Object.entries(properties)) {
      if (v !== undefined) {
        serialized[k] = v === null ? '' : String(v);
      }
    }

    await this.request(orgId, {
      method: 'PATCH',
      url: `/crm/v3/objects/deals/${dealId}`,
      data: { properties: serialized },
    });
  }

  async createNote(
    orgId: string,
    input: CreateNoteInput,
  ): Promise<{ id: string }> {
    const associations = this.buildInlineAssociations(input.targets, {
      dealTypeId: HS_ASSOC.NOTE_TO_DEAL,
      contactTypeId: HS_ASSOC.NOTE_TO_CONTACT,
      companyTypeId: HS_ASSOC.NOTE_TO_COMPANY,
    });

    const properties: Record<string, string> = {
      hs_timestamp: input.timestampIso,
      hs_note_body: input.bodyHtml,
    };
    if (input.ownerId) {
      properties.hubspot_owner_id = input.ownerId;
    }

    return this.request<{ id: string }>(orgId, {
      method: 'POST',
      url: '/crm/v3/objects/notes',
      data: { properties, associations },
    });
  }

  async createTask(
    orgId: string,
    input: CreateTaskInput,
  ): Promise<{ id: string }> {
    const associations = this.buildInlineAssociations(input.targets, {
      dealTypeId: HS_ASSOC.TASK_TO_DEAL,
      contactTypeId: HS_ASSOC.TASK_TO_CONTACT,
      companyTypeId: HS_ASSOC.TASK_TO_COMPANY,
    });

    const properties: Record<string, string> = {
      hs_timestamp: input.dueDateIso,
      hs_task_subject: input.subject,
      hs_task_body: input.bodyText,
      hs_task_status: 'NOT_STARTED',
      hs_task_priority: 'MEDIUM',
      hs_task_type: 'TODO',
    };
    if (input.ownerId) {
      properties.hubspot_owner_id = input.ownerId;
    }

    return this.request<{ id: string }>(orgId, {
      method: 'POST',
      url: '/crm/v3/objects/tasks',
      data: { properties, associations },
    });
  }

  async archiveObject(
    orgId: string,
    objectType: 'notes' | 'tasks',
    objectId: string,
  ): Promise<void> {
    await this.request(orgId, {
      method: 'DELETE',
      url: `/crm/v3/objects/${objectType}/${objectId}`,
    });
  }

  private buildInlineAssociations(
    targets: AssociationTargets,
    typeIds: {
      dealTypeId: number;
      contactTypeId: number;
      companyTypeId: number;
    },
  ) {
    const associations: Array<{
      to: { id: string };
      types: Array<{
        associationCategory: 'HUBSPOT_DEFINED';
        associationTypeId: number;
      }>;
    }> = [
      {
        to: { id: targets.dealId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: typeIds.dealTypeId,
          },
        ],
      },
    ];

    for (const contactId of targets.contactIds ?? []) {
      associations.push({
        to: { id: contactId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: typeIds.contactTypeId,
          },
        ],
      });
    }

    if (targets.companyId) {
      associations.push({
        to: { id: targets.companyId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: typeIds.companyTypeId,
          },
        ],
      });
    }
    return associations;
  }
}
