import { Injectable, Logger } from '@nestjs/common';
import { MatchMethod, ReviewReason } from '@prisma/client';
import { HubSpotService, HubSpotDealRecord } from '../hubspot/hubspot.service';
import { ClassifiedAttendee } from '../fathom/fathom.service';

// Blocklist of consumer/free email domains so Tier 2 never matches unrelated companies on gmail.com
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'zoho.com',
  'mail.com',
  'gmx.com',
  'fastmail.com',
  'hey.com',
  'yandex.com',
]);

export interface RankedDealCandidate {
  dealId: string;
  dealName: string;
  stage: string;
  pipeline: string;
  lastActivityAt: string;
}

export type DealMatchResult =
  | {
      outcome: 'MATCHED';
      deal: HubSpotDealRecord;
      matchMethod: MatchMethod;
      matchedContactIds: string[];
      matchedCompanyId: string | null;
    }
  | {
      outcome: 'NEEDS_REVIEW';
      reason: ReviewReason; // 'NO_MATCH' | 'AMBIGUOUS_MATCH'
      matchMethod: MatchMethod | null;
      candidates: RankedDealCandidate[];
      matchedContactIds: string[];
      matchedCompanyId: string | null;
    };

@Injectable()
export class DealMatcherService {
  private readonly logger = new Logger(DealMatcherService.name);

  constructor(private readonly hubspot: HubSpotService) {}

  async matchCallToDeal(
    orgId: string,
    callTitle: string | null,
    attendees: ClassifiedAttendee[],
    internalDomains: string[],
  ): Promise<DealMatchResult> {
    const internalSet = new Set(internalDomains.map((d) => d.toLowerCase()));

    const externalEmails = Array.from(
      new Set(
        attendees
          .filter((a) => a.isExternal && a.email)
          .map((a) => a.email!.toLowerCase().trim())
          .filter((email) => {
            const domain = email.split('@')[1];
            return domain && !internalSet.has(domain);
          }),
      ),
    );

    let matchedContactIds: string[] = [];
    let matchedCompanyId: string | null = null;

    // =========================================================================
    // TIER 1: External Attendee Email -> HubSpot Contact -> Open Deal
    // =========================================================================
    if (externalEmails.length > 0) {
      const contacts = await this.hubspot.findContactsByEmails(
        orgId,
        externalEmails,
      );
      matchedContactIds = contacts.map((c) => c.id);

      if (matchedContactIds.length > 0) {
        const dealIds = await this.hubspot.getAssociatedDealIds(
          orgId,
          'contacts',
          matchedContactIds,
        );
        const deals = await this.hubspot.getDealsByIds(orgId, dealIds);
        const openDeals = this.rankDealsByRecentActivity(
          deals.filter((d) => !d.hs_is_closed),
        );

        if (openDeals.length === 1) {
          this.logger.log({
            msg: 'Matched call to single open deal via ATTENDEE_EMAIL',
            orgId,
            dealId: openDeals[0].id,
          });
          return {
            outcome: 'MATCHED',
            deal: openDeals[0],
            matchMethod: MatchMethod.ATTENDEE_EMAIL,
            matchedContactIds,
            matchedCompanyId: null,
          };
        }

        if (openDeals.length > 1) {
          return {
            outcome: 'NEEDS_REVIEW',
            reason: ReviewReason.AMBIGUOUS_MATCH,
            matchMethod: MatchMethod.ATTENDEE_EMAIL,
            candidates: this.toCandidates(openDeals),
            matchedContactIds,
            matchedCompanyId: null,
          };
        }
      }
    }

    // =========================================================================
    // TIER 2: Corporate Email Domain -> HubSpot Company -> Open Deal
    // =========================================================================
    const corporateDomains = Array.from(
      new Set(
        externalEmails
          .map((e) => e.split('@')[1])
          .filter(
            (domain): domain is string =>
              Boolean(domain) &&
              !internalSet.has(domain) &&
              !PUBLIC_EMAIL_DOMAINS.has(domain),
          ),
      ),
    );

    if (corporateDomains.length > 0) {
      const companies = await this.hubspot.findCompaniesByDomains(
        orgId,
        corporateDomains,
      );
      const companyIds = companies.map((c) => c.id);
      matchedCompanyId = companyIds[0] ?? null;

      if (companyIds.length > 0) {
        const dealIds = await this.hubspot.getAssociatedDealIds(
          orgId,
          'companies',
          companyIds,
        );
        const deals = await this.hubspot.getDealsByIds(orgId, dealIds);
        const openDeals = this.rankDealsByRecentActivity(
          deals.filter((d) => !d.hs_is_closed),
        );

        if (openDeals.length === 1) {
          this.logger.log({
            msg: 'Matched call to single open deal via COMPANY_DOMAIN',
            orgId,
            dealId: openDeals[0].id,
            matchedCompanyId,
          });
          return {
            outcome: 'MATCHED',
            deal: openDeals[0],
            matchMethod: MatchMethod.COMPANY_DOMAIN,
            matchedContactIds,
            matchedCompanyId,
          };
        }

        if (openDeals.length > 1) {
          return {
            outcome: 'NEEDS_REVIEW',
            reason: ReviewReason.AMBIGUOUS_MATCH,
            matchMethod: MatchMethod.COMPANY_DOMAIN,
            candidates: this.toCandidates(openDeals),
            matchedContactIds,
            matchedCompanyId,
          };
        }
      }
    }

    // =========================================================================
    // TIER 3: Calendar Event Title -> Deal Name Search (Weak Signal: Review Only)
    // =========================================================================
    if (callTitle) {
      const candidateTokens = this.extractTitleSearchTokens(callTitle);
      const titleMatches = new Map<string, HubSpotDealRecord>();

      for (const token of candidateTokens) {
        const found = await this.hubspot.searchOpenDealsByKeyword(orgId, token);
        for (const deal of found) {
          titleMatches.set(deal.id, deal);
        }
      }

      if (titleMatches.size > 0) {
        const rankedTitleDeals = this.rankDealsByRecentActivity(
          Array.from(titleMatches.values()),
        );
        return {
          outcome: 'NEEDS_REVIEW',
          reason: ReviewReason.AMBIGUOUS_MATCH,
          matchMethod: MatchMethod.CALENDAR_TITLE,
          candidates: this.toCandidates(rankedTitleDeals),
          matchedContactIds,
          matchedCompanyId,
        };
      }
    }

    // =========================================================================
    // FALLBACK: No Open Deal Found
    // =========================================================================
    return {
      outcome: 'NEEDS_REVIEW',
      reason: ReviewReason.NO_MATCH,
      matchMethod: null,
      candidates: [],
      matchedContactIds,
      matchedCompanyId,
    };
  }

  /**
   * Ranks candidate deals descending by most recent activity timestamp
   */
  private rankDealsByRecentActivity(
    deals: HubSpotDealRecord[],
  ): HubSpotDealRecord[] {
    return [...deals].sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime() -
        new Date(a.lastActivityAt).getTime(),
    );
  }

  private toCandidates(deals: HubSpotDealRecord[]): RankedDealCandidate[] {
    return deals.map((d) => ({
      dealId: d.id,
      dealName: d.dealname,
      stage: d.dealstage,
      pipeline: d.pipeline,
      lastActivityAt: d.lastActivityAt,
    }));
  }

  /**
   * Splits calendar titles like "Acme Corp <> OurCompany - Pricing Sync" into clean search phrases
   */
  private extractTitleSearchTokens(title: string): string[] {
    const stopPhrases = new Set([
      'intro',
      'discovery',
      'demo',
      'pricing',
      'sync',
      'call',
      'meeting',
      'check-in',
      'followup',
      'follow-up',
      'review',
    ]);

    return title
      .split(/[-|:<>/×]+|\b(?:with|and|x)\b/i)
      .map((part) => part.trim())
      .filter(
        (part) => part.length >= 3 && !stopPhrases.has(part.toLowerCase()),
      )
      .slice(0, 3);
  }
}
