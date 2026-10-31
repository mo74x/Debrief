import { Injectable, Logger } from '@nestjs/common';
import { CrmWrite, CrmWriteStatus, CrmWriteType, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { HubSpotService } from '../hubspot/hubspot.service';
import { ResolvedExtraction } from '../extraction/schema/extraction.schema';

export interface ExecuteCallWritesInput {
  orgId: string;
  callId: string;
  dealId: string;
  callTitle: string | null;
  callStartedAt: Date;
  ownerId: string | null;
  contactIds: string[];
  companyId: string | null;
  extraction: ResolvedExtraction;
  shouldUpdateStage: boolean;
  targetStageId: string | null;
  shouldCreateTask: boolean;
}

@Injectable()
export class CrmWriterService {
  private readonly logger = new Logger(CrmWriterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly hubspot: HubSpotService,
  ) {}

  /**
   * Executes Note, Stage/Property, and Task writes under a per-deal Redis lock.
   * Safe to re-run after mid-flight worker crashes without duplicating CRM objects.
   */
  async executeCallWrites(input: ExecuteCallWritesInput): Promise<CrmWrite[]> {
    const lockKey = `lock:deal:${input.orgId}:${input.dealId}`;

    return this.redis.withLock(lockKey, 30_000, async () => {
      const completedWrites: CrmWrite[] = [];
      const targets = {
        dealId: input.dealId,
        contactIds: input.contactIds,
        companyId: input.companyId,
      };

      // =======================================================================
      // STEP 1: Write Call Summary Note (Always written for every passing call)
      // =======================================================================
      const noteHtml = this.formatCallNoteHtml(
        input.callTitle,
        input.extraction,
      );
      const noteWrite = await this.runWriteAheadStep({
        orgId: input.orgId,
        callId: input.callId,
        dealId: input.dealId,
        type: CrmWriteType.NOTE,
        beforeSnapshot: null,
        afterSnapshot: { hs_note_body: noteHtml },
        executeHubSpotCall: async () => {
          const created = await this.hubspot.createNote(input.orgId, {
            bodyHtml: noteHtml,
            ownerId: input.ownerId,
            timestampIso: new Date().toISOString(),
            targets,
          });
          return created.id;
        },
      });
      completedWrites.push(noteWrite);

      // =======================================================================
      // STEP 2: Update Deal Stage & Extracted Properties (When justified)
      // =======================================================================
      const hasExtractedProps =
        Object.keys(input.extraction.extracted_stage_properties || {}).length >
        0;
      const nextStepSummary = input.extraction.next_step
        ? `${input.extraction.next_step.action} (Due: ${input.extraction.next_step.due_date_iso.slice(0, 10)})`
        : undefined;

      if (input.shouldUpdateStage || hasExtractedProps || nextStepSummary) {
        const propKeysToRead = [
          'dealstage',
          'hs_next_step',
          ...Object.keys(input.extraction.extracted_stage_properties || {}),
        ];
        const currentProps = await this.hubspot.getDealProperties(
          input.orgId,
          input.dealId,
          propKeysToRead,
        );

        const beforePatch: Record<string, string | null> = {};
        const afterPatch: Record<string, string | number | boolean> = {};

        if (input.shouldUpdateStage && input.targetStageId) {
          beforePatch.dealstage = currentProps.dealstage ?? null;
          afterPatch.dealstage = input.targetStageId;
        }

        if (nextStepSummary) {
          beforePatch.hs_next_step = currentProps.hs_next_step ?? null;
          afterPatch.hs_next_step = nextStepSummary;
        }

        for (const [key, val] of Object.entries(
          input.extraction.extracted_stage_properties || {},
        )) {
          beforePatch[key] = currentProps[key] ?? null;
          afterPatch[key] = val;
        }

        const writeType = input.shouldUpdateStage
          ? CrmWriteType.STAGE
          : CrmWriteType.PROPERTY;

        const stageWrite = await this.runWriteAheadStep({
          orgId: input.orgId,
          callId: input.callId,
          dealId: input.dealId,
          type: writeType,
          beforeSnapshot: beforePatch,
          afterSnapshot: afterPatch,
          executeHubSpotCall: async () => {
            await this.hubspot.updateDealProperties(
              input.orgId,
              input.dealId,
              afterPatch,
            );
            return input.dealId;
          },
        });
        completedWrites.push(stageWrite);
      }

      // =======================================================================
      // STEP 3: Create Next-Step Task (When present & not deduplicated)
      // =======================================================================
      if (input.shouldCreateTask && input.extraction.next_step) {
        const nextStep = input.extraction.next_step;
        const taskBody = this.formatTaskBody(input.callTitle, nextStep);

        const taskWrite = await this.runWriteAheadStep({
          orgId: input.orgId,
          callId: input.callId,
          dealId: input.dealId,
          type: CrmWriteType.TASK,
          beforeSnapshot: null,
          afterSnapshot: {
            subject: nextStep.action,
            dueDateIso: nextStep.due_date_iso,
            owner: nextStep.owner,
          },
          executeHubSpotCall: async () => {
            const created = await this.hubspot.createTask(input.orgId, {
              subject: nextStep.action,
              bodyText: taskBody,
              dueDateIso: nextStep.due_date_iso,
              ownerId: input.ownerId,
              targets,
            });
            return created.id;
          },
        });
        completedWrites.push(taskWrite);
      }

      return completedWrites;
    });
  }

  /**
   * Write-Ahead Executor:
   * 1. Checks if (callId, type) was already WRITTEN on an earlier attempt.
   * 2. Upserts PENDING row with before/after payloads.
   * 3. Executes HubSpot mutation and marks row WRITTEN (or FAILED on exception).
   */
  private async runWriteAheadStep(params: {
    orgId: string;
    callId: string;
    dealId: string;
    type: CrmWriteType;
    beforeSnapshot: Record<string, unknown> | null;
    afterSnapshot: Record<string, unknown>;
    executeHubSpotCall: () => Promise<string>;
  }): Promise<CrmWrite> {
    const existing = await this.prisma.crmWrite.findUnique({
      where: {
        callId_type: {
          callId: params.callId,
          type: params.type,
        },
      },
    });

    if (existing && existing.status === CrmWriteStatus.WRITTEN) {
      this.logger.log({
        msg: 'Skipping already-completed CRM write step on retry',
        callId: params.callId,
        type: params.type,
        hubspotObjectId: existing.hubspotObjectId,
      });
      return existing;
    }

    const pendingRecord = await this.prisma.crmWrite.upsert({
      where: {
        callId_type: {
          callId: params.callId,
          type: params.type,
        },
      },
      create: {
        orgId: params.orgId,
        callId: params.callId,
        dealId: params.dealId,
        type: params.type,
        status: CrmWriteStatus.PENDING,
        before: (params.beforeSnapshot ??
          Prisma.JsonNull) as Prisma.InputJsonValue,
        after: params.afterSnapshot as Prisma.InputJsonValue,
      },
      update: {
        status: CrmWriteStatus.PENDING,
        before: (params.beforeSnapshot ??
          Prisma.JsonNull) as Prisma.InputJsonValue,
        after: params.afterSnapshot as Prisma.InputJsonValue,
        error: null,
      },
    });

    try {
      const hubspotObjectId = await params.executeHubSpotCall();

      return await this.prisma.crmWrite.update({
        where: { id: pendingRecord.id },
        data: {
          status: CrmWriteStatus.WRITTEN,
          hubspotObjectId,
          error: null,
        },
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.prisma.crmWrite.update({
        where: { id: pendingRecord.id },
        data: {
          status: CrmWriteStatus.FAILED,
          error: errorMessage,
        },
      });
      throw err;
    }
  }

  private formatCallNoteHtml(
    callTitle: string | null,
    extraction: ResolvedExtraction,
  ): string {
    const title = this.escapeHtml(callTitle || 'Sales Call');
    const summary = this.escapeHtml(extraction.summary);
    const keyPointsHtml = extraction.key_points
      .map((pt) => `<li>${this.escapeHtml(pt)}</li>`)
      .join('');

    const risksHtml =
      extraction.risks.length > 0
        ? `<p><strong>Risks / Blockers:</strong></p><ul>${extraction.risks
            .map((r) => `<li>${this.escapeHtml(r)}</li>`)
            .join('')}</ul>`
        : '';

    const stageQuoteHtml =
      extraction.stage_proposal.new_stage_id &&
      extraction.stage_proposal.evidence.length > 0
        ? `<p><strong>Stage Signal (${this.escapeHtml(extraction.stage_proposal.new_stage_id)}):</strong> <em>"${this.escapeHtml(
            extraction.stage_proposal.evidence[0].exact_quote,
          )}"</em></p>`
        : '';

    const nextStepHtml = extraction.next_step
      ? `<p><strong>Next Step (${this.escapeHtml(extraction.next_step.owner.toUpperCase())}):</strong> ${this.escapeHtml(
          extraction.next_step.action,
        )} — Due ${this.escapeHtml(extraction.next_step.due_date_iso.slice(0, 10))}</p>`
      : '';

    return [
      `<p><strong>Call Summary: ${title}</strong></p>`,
      `<p>${summary}</p>`,
      `<p><strong>Key Takeaways:</strong></p><ul>${keyPointsHtml}</ul>`,
      stageQuoteHtml,
      nextStepHtml,
      risksHtml,
    ]
      .filter(Boolean)
      .join('');
  }

  private formatTaskBody(
    callTitle: string | null,
    nextStep: NonNullable<ResolvedExtraction['next_step']>,
  ): string {
    const quote = nextStep.evidence[0]?.exact_quote ?? '';
    return [
      `Auto-created from call: ${callTitle || 'Sales Call'}`,
      `Owner: ${nextStep.owner}`,
      quote ? `Transcript Evidence: "${quote}"` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
