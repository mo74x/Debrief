import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  CallStatus,
  MatchMethod,
  Prisma,
  ReviewReason,
  ReviewStatus,
} from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../common/prisma/prisma.service';
import { HubSpotService } from '../hubspot/hubspot.service';
import { CrmWriterService } from '../writer/crm-writer.service';
import { NotifyService } from '../notify/notify.service';
import { CALLS_QUEUE } from '../fathom/fathom.service';
import {
  ResolvedExtraction,
  ResolvedExtractionSchema,
} from '../extraction/schema/extraction.schema';

export const EditReviewProposalDtoSchema = z.object({
  summary: z.string().min(10).max(1200).optional(),
  new_stage_id: z.string().nullable().optional(),
  next_step: z
    .object({
      action: z.string().min(3),
      owner: z.enum(['rep', 'prospect']),
      due_date_iso: z.string().datetime(),
    })
    .nullable()
    .optional(),
  extracted_stage_properties: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  force: z.boolean().default(false),
});

export type EditReviewProposalDto = z.infer<typeof EditReviewProposalDtoSchema>;

@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hubspot: HubSpotService,
    private readonly crmWriter: CrmWriterService,
    private readonly notify: NotifyService,
    @InjectQueue(CALLS_QUEUE) private readonly callsQueue: Queue,
  ) {}

  async listOpenReviewItems(orgId: string) {
    return this.prisma.reviewItem.findMany({
      where: { orgId, status: ReviewStatus.OPEN },
      include: {
        call: {
          select: {
            id: true,
            title: true,
            startedAt: true,
            dealId: true,
            matchMethod: true,
            attendees: true,
            failureReason: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 1. Approves an open ReviewItem and writes the proposal to HubSpot
   */
  async approveReviewItem(
    orgId: string,
    reviewId: string,
    userId?: string,
    force = false,
  ) {
    const item = await this.prisma.reviewItem.findFirst({
      where: { id: reviewId, orgId },
      include: {
        call: { include: { hostUser: true } },
      },
    });

    if (!item) {
      throw new NotFoundException(`ReviewItem ${reviewId} not found.`);
    }

    if (item.status !== ReviewStatus.OPEN) {
      throw new BadRequestException(
        `ReviewItem ${reviewId} is already in status ${item.status}.`,
      );
    }

    if (!item.call.dealId) {
      throw new BadRequestException(
        `Call ${item.callId} has no matched dealId. Call POST /calls/${item.callId}/match first.`,
      );
    }

    const parsedProposal = ResolvedExtractionSchema.safeParse(item.proposal);
    if (!parsedProposal.success) {
      throw new BadRequestException({
        message:
          'Stored proposal is incomplete or invalid; use POST /review/:id/edit to supply valid fields.',
        errors: parsedProposal.error.flatten(),
      });
    }

    return this.executeApprovedOrEditedProposal({
      orgId,
      reviewItemId: item.id,
      call: item.call,
      expectedDealStage: item.expectedDealStage,
      extraction: parsedProposal.data,
      resolutionStatus: ReviewStatus.APPROVED,
      userId,
      force,
    });
  }

  /**
   * 2. Applies rep edits to the proposal, validates, and writes to HubSpot
   */
  async editAndApproveReviewItem(
    orgId: string,
    reviewId: string,
    dtoInput: unknown,
    userId?: string,
  ) {
    const dto = EditReviewProposalDtoSchema.parse(dtoInput);

    const item = await this.prisma.reviewItem.findFirst({
      where: { id: reviewId, orgId },
      include: {
        call: { include: { hostUser: true } },
      },
    });

    if (!item) {
      throw new NotFoundException(`ReviewItem ${reviewId} not found.`);
    }

    if (item.status !== ReviewStatus.OPEN) {
      throw new BadRequestException(
        `ReviewItem ${reviewId} is already in status ${item.status}.`,
      );
    }

    if (!item.call.dealId) {
      throw new BadRequestException(
        `Call ${item.callId} has no matched dealId. Call POST /calls/${item.callId}/match first.`,
      );
    }

    const existingProposal = (item.proposal ??
      {}) as Partial<ResolvedExtraction>;

    const merged: ResolvedExtraction = {
      summary:
        dto.summary ?? existingProposal.summary ?? 'Summary updated by rep.',
      key_points: existingProposal.key_points ?? ['Reviewed by sales rep'],
      stage_proposal: {
        new_stage_id:
          dto.new_stage_id !== undefined
            ? dto.new_stage_id
            : (existingProposal.stage_proposal?.new_stage_id ?? null),
        confidence: 1.0,
        reasoning: 'Manually edited and approved by rep.',
        evidence: existingProposal.stage_proposal?.evidence ?? [],
      },
      next_step:
        dto.next_step !== undefined
          ? dto.next_step
            ? {
                action: dto.next_step.action,
                owner: dto.next_step.owner,
                due_date_raw: 'manual_override',
                due_date_iso: dto.next_step.due_date_iso,
                due_date_inferred: false,
                evidence: existingProposal.next_step?.evidence ?? [
                  { turn_id: 0, exact_quote: 'Manual rep override' },
                ],
              }
            : null
          : (existingProposal.next_step ?? null),
      extracted_stage_properties: {
        ...(existingProposal.extracted_stage_properties ?? {}),
        ...(dto.extracted_stage_properties ?? {}),
      },
      risks: existingProposal.risks ?? [],
      no_update_reason: existingProposal.no_update_reason ?? null,
    };

    return this.executeApprovedOrEditedProposal({
      orgId,
      reviewItemId: item.id,
      call: item.call,
      expectedDealStage: item.expectedDealStage,
      extraction: merged,
      resolutionStatus: ReviewStatus.EDITED,
      userId,
      force: dto.force,
    });
  }

  /**
   * 3. Rejects a ReviewItem and marks the Call as SKIPPED
   */
  async rejectReviewItem(orgId: string, reviewId: string, userId?: string) {
    const item = await this.prisma.reviewItem.findFirst({
      where: { id: reviewId, orgId },
    });

    if (!item) {
      throw new NotFoundException(`ReviewItem ${reviewId} not found.`);
    }

    if (item.status !== ReviewStatus.OPEN) {
      throw new BadRequestException(
        `ReviewItem ${reviewId} is already in status ${item.status}.`,
      );
    }

    const [updatedReview] = await this.prisma.$transaction([
      this.prisma.reviewItem.update({
        where: { id: item.id },
        data: {
          status: ReviewStatus.REJECTED,
          resolvedById: userId ?? null,
          resolvedAt: new Date(),
        },
      }),
      this.prisma.call.update({
        where: { id: item.callId },
        data: {
          status: CallStatus.SKIPPED,
          failureReason: 'Proposal rejected by reviewer.',
        },
      }),
    ]);

    return updatedReview;
  }

  /**
   * 4. Manually assigns a HubSpot deal to an unmatched/ambiguous Call and resumes processing at Extraction
   */
  async manualMatchDeal(
    orgId: string,
    callId: string,
    dealId: string,
    userId?: string,
  ) {
    const call = await this.prisma.call.findFirst({
      where: { id: callId, orgId },
    });

    if (!call) {
      throw new NotFoundException(`Call ${callId} not found.`);
    }

    const [deal] = await this.hubspot.getDealsByIds(orgId, [dealId]);
    if (!deal) {
      throw new BadRequestException(`HubSpot Deal ${dealId} not found.`);
    }

    await this.prisma.$transaction([
      // Close any open NO_MATCH or AMBIGUOUS_MATCH review items for this call
      this.prisma.reviewItem.updateMany({
        where: {
          callId,
          orgId,
          status: ReviewStatus.OPEN,
          reason: { in: [ReviewReason.NO_MATCH, ReviewReason.AMBIGUOUS_MATCH] },
        },
        data: {
          status: ReviewStatus.APPROVED,
          resolvedById: userId ?? null,
          resolvedAt: new Date(),
        },
      }),
      // Transition Call to MATCHED so CallProcessor resumes at Stage 3 (Extraction)
      this.prisma.call.update({
        where: { id: callId },
        data: {
          dealId: deal.id,
          matchMethod: MatchMethod.MANUAL,
          status: CallStatus.MATCHED,
          failureReason: null,
        },
      }),
    ]);

    // Re-enqueue job with a fresh run suffix so BullMQ processes the resumed state immediately
    await this.callsQueue.add(
      'process-call',
      { callId: call.id, orgId },
      {
        jobId: `${call.id}:manual:${Date.now()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
      },
    );

    this.logger.log({
      msg: 'Manually matched call to deal and re-enqueued for extraction',
      orgId,
      callId,
      dealId: deal.id,
    });

    return {
      status: 'requeued',
      callId,
      dealId: deal.id,
      dealName: deal.dealname,
    };
  }

  private async executeApprovedOrEditedProposal(params: {
    orgId: string;
    reviewItemId: string;
    call: Prisma.CallGetPayload<{ include: { hostUser: true } }>;
    expectedDealStage: string | null;
    extraction: ResolvedExtraction;
    resolutionStatus: ReviewStatus;
    userId?: string;
    force: boolean;
  }) {
    const dealId = params.call.dealId!;
    const [liveDeal] = await this.hubspot.getDealsByIds(params.orgId, [dealId]);
    if (!liveDeal) {
      throw new NotFoundException(
        `Deal ${dealId} no longer exists in HubSpot.`,
      );
    }

    // Stale-stage guard: prevent overwriting a deal that moved while the ReviewItem sat open
    if (
      params.expectedDealStage &&
      liveDeal.dealstage !== params.expectedDealStage &&
      !params.force
    ) {
      throw new ConflictException({
        message:
          'Deal stage in HubSpot has changed since this review item was created. Pass force=true to write anyway.',
        expectedDealStage: params.expectedDealStage,
        currentHubSpotStage: liveDeal.dealstage,
      });
    }

    const shouldUpdateStage =
      params.extraction.stage_proposal.new_stage_id !== null &&
      params.extraction.stage_proposal.new_stage_id !== liveDeal.dealstage;

    const writes = await this.crmWriter.executeCallWrites({
      orgId: params.orgId,
      callId: params.call.id,
      dealId: liveDeal.id,
      callTitle: params.call.title,
      callStartedAt: params.call.startedAt,
      ownerId: params.call.hostUser?.hubspotOwnerId ?? null,
      contactIds: params.call.matchedContactIds,
      companyId: params.call.matchedCompanyId,
      extraction: params.extraction,
      shouldUpdateStage,
      targetStageId: params.extraction.stage_proposal.new_stage_id,
      shouldCreateTask: params.extraction.next_step !== null,
    });

    const [updatedReview] = await this.prisma.$transaction([
      this.prisma.reviewItem.update({
        where: { id: params.reviewItemId },
        data: {
          status: params.resolutionStatus,
          proposal: params.extraction,
          resolvedById: params.userId ?? null,
          resolvedAt: new Date(),
        },
      }),
      this.prisma.call.update({
        where: { id: params.call.id },
        data: {
          extraction: params.extraction,
          status: CallStatus.WRITTEN,
          failureReason: null,
        },
      }),
    ]);

    await this.notify.notifyWriteCompleted({
      orgId: params.orgId,
      callId: params.call.id,
      callTitle: params.call.title,
      dealId: liveDeal.id,
      dealName: liveDeal.dealname,
      slackUserId: params.call.hostUser?.slackUserId,
      extraction: params.extraction,
      writes,
    });

    return { reviewItem: updatedReview, writes };
  }
}
