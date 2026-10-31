/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { MatchMethod, ReviewReason } from '@prisma/client';
import { DealMatcherService } from './deal-matcher.service';
import { HubSpotService, HubSpotDealRecord } from '../hubspot/hubspot.service';
import { ClassifiedAttendee } from '../fathom/fathom.service';

describe('DealMatcherService', () => {
  let service: DealMatcherService;
  let hubspot: jest.Mocked<
    Pick<
      HubSpotService,
      | 'findContactsByEmails'
      | 'findCompaniesByDomains'
      | 'getAssociatedDealIds'
      | 'getDealsByIds'
      | 'searchOpenDealsByKeyword'
    >
  >;

  const ORG_ID = 'org_test_123';
  const INTERNAL_DOMAINS = ['ourcompany.com'];

  const makeDeal = (
    overrides: Partial<HubSpotDealRecord> & { id: string },
  ): HubSpotDealRecord => ({
    id: overrides.id,
    dealname: overrides.dealname ?? `Deal ${overrides.id}`,
    dealstage: overrides.dealstage ?? 'qualifiedtobuy',
    pipeline: overrides.pipeline ?? 'default',
    amount: overrides.amount ?? '25000',
    closedate: overrides.closedate ?? '2026-12-15T00:00:00.000Z',
    hs_is_closed: overrides.hs_is_closed ?? false,
    lastActivityAt: overrides.lastActivityAt ?? '2026-10-15T12:00:00.000Z',
  });

  beforeEach(async () => {
    hubspot = {
      findContactsByEmails: jest.fn().mockResolvedValue([]),
      findCompaniesByDomains: jest.fn().mockResolvedValue([]),
      getAssociatedDealIds: jest.fn().mockResolvedValue([]),
      getDealsByIds: jest.fn().mockResolvedValue([]),
      searchOpenDealsByKeyword: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DealMatcherService,
        {
          provide: HubSpotService,
          useValue: hubspot,
        },
      ],
    }).compile();

    service = module.get<DealMatcherService>(DealMatcherService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Tier 1: Exact Attendee Email Match (ATTENDEE_EMAIL)', () => {
    it('matches a single open deal, ignores internal attendees, and filters out closed deals', async () => {
      const attendees: ClassifiedAttendee[] = [
        { name: 'Alex Rep', email: 'alex@ourcompany.com', isExternal: false },
        { name: 'Sara Buyer', email: 'sara@acmecorp.io', isExternal: true },
      ];

      hubspot.findContactsByEmails.mockResolvedValue([
        { id: 'contact_sara', email: 'sara@acmecorp.io' },
      ]);
      hubspot.getAssociatedDealIds.mockResolvedValue([
        'deal_open_1',
        'deal_closed_old',
      ]);
      hubspot.getDealsByIds.mockResolvedValue([
        makeDeal({
          id: 'deal_open_1',
          dealname: 'Acme Corp - Enterprise',
          hs_is_closed: false,
        }),
        makeDeal({
          id: 'deal_closed_old',
          dealname: 'Acme Corp - 2025 Pilot',
          hs_is_closed: true,
        }),
      ]);

      const result = await service.matchCallToDeal(
        ORG_ID,
        'Acme Corp Discovery',
        attendees,
        INTERNAL_DOMAINS,
      );

      // Internal email must never be queried against HubSpot Contacts
      expect(hubspot.findContactsByEmails).toHaveBeenCalledWith(ORG_ID, [
        'sara@acmecorp.io',
      ]);
      expect(hubspot.getAssociatedDealIds).toHaveBeenCalledWith(
        ORG_ID,
        'contacts',
        ['contact_sara'],
      );
      // Tier 2 and Tier 3 should not run when Tier 1 resolves
      expect(hubspot.findCompaniesByDomains).not.toHaveBeenCalled();

      expect(result).toEqual({
        outcome: 'MATCHED',
        deal: expect.objectContaining({
          id: 'deal_open_1',
          dealname: 'Acme Corp - Enterprise',
        }),
        matchMethod: MatchMethod.ATTENDEE_EMAIL,
        matchedContactIds: ['contact_sara'],
        matchedCompanyId: null,
      });
    });

    it('routes to AMBIGUOUS_MATCH with candidates ranked by most recent activity when multiple open deals exist', async () => {
      const attendees: ClassifiedAttendee[] = [
        { name: 'Sara Buyer', email: 'sara@acmecorp.io', isExternal: true },
      ];

      hubspot.findContactsByEmails.mockResolvedValue([
        { id: 'contact_sara', email: 'sara@acmecorp.io' },
      ]);
      hubspot.getAssociatedDealIds.mockResolvedValue([
        'deal_stale',
        'deal_recent',
        'deal_mid',
        'deal_closed',
      ]);
      hubspot.getDealsByIds.mockResolvedValue([
        makeDeal({
          id: 'deal_stale',
          dealname: 'Acme Legacy Expansion',
          lastActivityAt: '2026-09-01T08:00:00.000Z',
        }),
        makeDeal({
          id: 'deal_recent',
          dealname: 'Acme Core Platform',
          lastActivityAt: '2026-10-30T16:45:00.000Z',
        }),
        makeDeal({
          id: 'deal_mid',
          dealname: 'Acme Security Add-On',
          lastActivityAt: '2026-10-12T11:20:00.000Z',
        }),
        makeDeal({
          id: 'deal_closed',
          dealname: 'Acme Closed Deal',
          hs_is_closed: true,
          lastActivityAt: '2026-10-31T00:00:00.000Z',
        }),
      ]);

      const result = await service.matchCallToDeal(
        ORG_ID,
        'Acme Sync',
        attendees,
        INTERNAL_DOMAINS,
      );

      expect(result.outcome).toBe('NEEDS_REVIEW');
      if (result.outcome === 'NEEDS_REVIEW') {
        expect(result.reason).toBe(ReviewReason.AMBIGUOUS_MATCH);
        expect(result.matchMethod).toBe(MatchMethod.ATTENDEE_EMAIL);
        expect(result.candidates.map((c) => c.dealId)).toEqual([
          'deal_recent',
          'deal_mid',
          'deal_stale',
        ]);
      }
    });
  });

  describe('Tier 2: Corporate Domain Match & Consumer Domain Filtering (COMPANY_DOMAIN)', () => {
    it('falls back to corporate domain matching when an unrecognized stakeholder from the same company joins', async () => {
      const attendees: ClassifiedAttendee[] = [
        { name: 'New CFO', email: 'cfo@acmecorp.io', isExternal: true },
      ];

      // Contact does not exist in HubSpot yet
      hubspot.findContactsByEmails.mockResolvedValue([]);

      // Company domain matches Acme Corp
      hubspot.findCompaniesByDomains.mockResolvedValue([
        { id: 'company_acme', domain: 'acmecorp.io', name: 'Acme Corp' },
      ]);
      hubspot.getAssociatedDealIds.mockResolvedValue(['deal_acme_1']);
      hubspot.getDealsByIds.mockResolvedValue([
        makeDeal({ id: 'deal_acme_1', dealname: 'Acme Corp Deal' }),
      ]);

      const result = await service.matchCallToDeal(
        ORG_ID,
        'CFO Intro',
        attendees,
        INTERNAL_DOMAINS,
      );

      expect(hubspot.findCompaniesByDomains).toHaveBeenCalledWith(ORG_ID, [
        'acmecorp.io',
      ]);
      expect(hubspot.getAssociatedDealIds).toHaveBeenCalledWith(
        ORG_ID,
        'companies',
        ['company_acme'],
      );
      expect(result).toEqual({
        outcome: 'MATCHED',
        deal: expect.objectContaining({ id: 'deal_acme_1' }),
        matchMethod: MatchMethod.COMPANY_DOMAIN,
        matchedContactIds: [],
        matchedCompanyId: 'company_acme',
      });
    });

    it('blocks consumer email domains (gmail.com, outlook.com, icloud.com) from querying HubSpot companies', async () => {
      const attendees: ClassifiedAttendee[] = [
        {
          name: 'Stealth Founder',
          email: 'founder@gmail.com',
          isExternal: true,
        },
        {
          name: 'Co-Founder',
          email: 'cofounder@outlook.com',
          isExternal: true,
        },
        { name: 'Advisor', email: 'advisor@icloud.com', isExternal: true },
      ];

      hubspot.findContactsByEmails.mockResolvedValue([]);

      const result = await service.matchCallToDeal(
        ORG_ID,
        null,
        attendees,
        INTERNAL_DOMAINS,
      );

      // Must never query HubSpot Companies with gmail.com / outlook.com / icloud.com
      expect(hubspot.findCompaniesByDomains).not.toHaveBeenCalled();
      expect(result).toEqual({
        outcome: 'NEEDS_REVIEW',
        reason: ReviewReason.NO_MATCH,
        matchMethod: null,
        candidates: [],
        matchedContactIds: [],
        matchedCompanyId: null,
      });
    });
  });

  describe('Tier 3: Calendar Event Title Fallback (CALENDAR_TITLE)', () => {
    it('strips meeting stop-words, searches open deals by title token, and ALWAYS routes to review even with 1 match', async () => {
      const attendees: ClassifiedAttendee[] = [
        {
          name: 'Personal Email Prospect',
          email: 'buyer@gmail.com',
          isExternal: true,
        },
      ];

      hubspot.findContactsByEmails.mockResolvedValue([]);
      hubspot.searchOpenDealsByKeyword.mockImplementation(
        async (_orgId, keyword) => {
          if (keyword === 'Globex Systems') {
            return [
              makeDeal({
                id: 'deal_globex',
                dealname: 'Globex Systems - Annual License',
                lastActivityAt: '2026-10-28T10:00:00.000Z',
              }),
            ];
          }
          return [];
        },
      );

      const result = await service.matchCallToDeal(
        ORG_ID,
        'Globex Systems <> OurCompany - Pricing & Discovery',
        attendees,
        INTERNAL_DOMAINS,
      );

      expect(hubspot.searchOpenDealsByKeyword).toHaveBeenCalledWith(
        ORG_ID,
        'Globex Systems',
      );
      expect(hubspot.searchOpenDealsByKeyword).toHaveBeenCalledWith(
        ORG_ID,
        'OurCompany',
      );

      // Even though exactly 1 deal matched the title, Tier 3 is a weak signal and MUST route to review
      expect(result).toEqual({
        outcome: 'NEEDS_REVIEW',
        reason: ReviewReason.AMBIGUOUS_MATCH,
        matchMethod: MatchMethod.CALENDAR_TITLE,
        candidates: [
          {
            dealId: 'deal_globex',
            dealName: 'Globex Systems - Annual License',
            stage: 'qualifiedtobuy',
            pipeline: 'default',
            lastActivityAt: '2026-10-28T10:00:00.000Z',
          },
        ],
        matchedContactIds: [],
        matchedCompanyId: null,
      });
    });
  });

  describe('Fallback: NO_MATCH', () => {
    it('returns NO_MATCH when contact, domain, and title searches all yield zero open deals', async () => {
      const attendees: ClassifiedAttendee[] = [
        {
          name: 'Unknown Prospect',
          email: 'nobody@newstartup.ai',
          isExternal: true,
        },
      ];

      hubspot.findContactsByEmails.mockResolvedValue([]);
      hubspot.findCompaniesByDomains.mockResolvedValue([]);
      hubspot.searchOpenDealsByKeyword.mockResolvedValue([]);

      const result = await service.matchCallToDeal(
        ORG_ID,
        'Quick Intro Call',
        attendees,
        INTERNAL_DOMAINS,
      );

      expect(result).toEqual({
        outcome: 'NEEDS_REVIEW',
        reason: ReviewReason.NO_MATCH,
        matchMethod: null,
        candidates: [],
        matchedContactIds: [],
        matchedCompanyId: null,
      });
    });
  });
});
