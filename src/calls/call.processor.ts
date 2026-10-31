import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Call, CallStatus, Prisma, ReviewReason } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  FathomService,
  CALLS_QUEUE,
  ClassifiedAttendee,
} from '../fathom/fathom.service';
import { HubSpotService, OrgPipelineConfig } from '../hubspot/hubspot.service';
import { DealMatcherService } from '../matching/deal-matcher.service';
import { ExtractionService } from '../extraction/extraction.service';
import {
  ResolvedExtraction,
  TranscriptTurn,
} from '../extraction/schema/extraction.schema';
import { ValidationService } from '../validation/validation.service';
import { CrmWriterService } from '../writer/crm-writer.service';

export interface ProcessCallJobData {
  callId: string;
  orgId: string;
}

@Processor(CALLS_QUEUE, { concurrency: 5 })
export class CallProcessor extends WorkerHost {
  private readonly logger = new Logger(CallProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fathomService: FathomService,
    private readonly hubspotService: HubSpotService,
    private readonly dealMatcher: DealMatcherService,
    private readonly extractionService: ExtractionService,
    private readonly validationService: ValidationService,
    private readonly crmWriter: CrmWriterService,
  ) {
    super();
  }

  async process(job: Job<ProcessCallJobData>): Promise<{ status: CallStatus }> {
    const { callId, orgId } = job.data;
    const startMs = Date.now();

    let call = await this.prisma.call.findUniqueOrThrow({
      where: { id: callId },
      include: { org: true, hostUser: true },
    });

    // Terminal states: exit immediately
    if (
      call.status === CallStatus.WRITTEN ||
      call.status === CallStatus.NEEDS_REVIEW ||
      call.status === CallStatus.SKIPPED
    ) {
      return { status: call.status };
    }

    // =========================================================================
    // STAGE 1: Fetch & Persist Indexed Transcript Turns (if not yet fetched)
    // =========================================================================
    let turns =
      (call.transcriptTurns as unknown as TranscriptTurn[] | null) ?? null;
    if (!turns) {
      turns = await this.fathomService.fetchAndNormalizeTranscript(
        orgId,
        call.fathomCallId,
      );

      if (turns.length === 0) {
        await this.prisma.call.update({
          where: { id: callId },
          data: {
            status: CallStatus.SKIPPED,
            failureReason: 'Empty transcript returned by Fathom.',
          },
        });
        return { status: CallStatus.SKIPPED };
      }

      call = await this.prisma.call.update({
        where: { id: callId },
        data: {
          transcriptTurns: turns,
        },
        include: { org: true, hostUser: true },
      });
    }

    // =========================================================================
    // STAGE 2: Deterministic Deal Matching (if Call.status === RECEIVED)
    // =========================================================================
    if (call.status === CallStatus.RECEIVED || !call.dealId) {
      const attendees =
        (call.attendees as unknown as ClassifiedAttendee[]) ?? [];
      const matchResult = await this.dealMatcher.matchCallToDeal(
        orgId,
        call.title,
        attendees,
        call.org.internalDomains,
      );

      if (matchResult.outcome === 'NEEDS_REVIEW') {
        await this.routeToReview({
          orgId,
          callId,
          reason: matchResult.reason,
          expectedDealStage: null,
          candidateDeals: matchResult.candidates,
          proposal: {},
          failureReason: `Deal matching requires review: ${matchResult.reason}`,
          matchedContactIds: matchResult.matchedContactIds,
          matchedCompanyId: matchResult.matchedCompanyId,
          matchMethod: matchResult.matchMethod,
        });
        return { status: CallStatus.NEEDS_REVIEW };
      }

      call = await this.prisma.call.update({
        where: { id: callId },
        data: {
          dealId: matchResult.deal.id,
          matchMethod: matchResult.matchMethod,
          matchedContactIds: matchResult.matchedContactIds,
          matchedCompanyId: matchResult.matchedCompanyId,
          status: CallStatus.MATCHED,
        },
        include: { org: true, hostUser: true },
      });
    }

    // Load live HubSpot deal record and pipeline configuration
    const [deal] = await this.hubspotService.getDealsByIds(orgId, [
      call.dealId!,
    ]);
    if (!deal) {
      await this.routeToReview({
        orgId,
        callId,
        reason: ReviewReason.NO_MATCH,
        expectedDealStage: null,
        candidateDeals: [],
        proposal: {},
        failureReason: `Deal ${call.dealId} no longer exists in HubSpot.`,
      });
      return { status: CallStatus.NEEDS_REVIEW };
    }

    const pipelineConfig = (call.org
      .pipelineConfig as unknown as OrgPipelineConfig) ?? { pipelines: {} };
    const dealPipeline = pipelineConfig.pipelines?.[deal.pipeline];
    const pipelineStages = dealPipeline?.stages ?? [];
    const currentStageObj = pipelineStages.find((s) => s.id === deal.dealstage);

    // =========================================================================
    // STAGE 3: Claude Structured Extraction & Evidence Verification
    // =========================================================================
    let resolvedExtraction =
      (call.extraction as unknown as ResolvedExtraction | null) ?? null;

    if (call.status === CallStatus.MATCHED || !resolvedExtraction) {
      const formattedTranscriptTurns =
        this.fathomService.formatTurnsForPrompt(turns);

      const extractionOutcome =
        await this.extractionService.extractAndVerifyCall(
          {
            callTitle: call.title,
            callStartedAtIso: call.startedAt.toISOString(),
            dealName: deal.dealname,
            currentStageId: deal.dealstage,
            currentStageLabel: currentStageObj?.label ?? deal.dealstage,
            pipelineStages,
            formattedTranscriptTurns,
          },
          turns,
          call.startedAt,
        );

      if (!extractionOutcome.ok) {
        await this.routeToReview({
          orgId,
          callId,
          reason: ReviewReason.INVALID_OUTPUT,
          expectedDealStage: deal.dealstage,
          candidateDeals: null,
          proposal:
            (extractionOutcome.partialRaw as Record<string, unknown>) ?? {},
          failureReason: extractionOutcome.errors.join(' | '),
        });
        return { status: CallStatus.NEEDS_REVIEW };
      }

      resolvedExtraction = extractionOutcome.resolved;

      call = await this.prisma.call.update({
        where: { id: callId },
        data: {
          extraction: resolvedExtraction as unknown as Prisma.InputJsonValue,
          status: CallStatus.EXTRACTED,
        },
        include: { org: true, hostUser: true },
      });
    }

    // =========================================================================
    // STAGE 4: Business Rules Validation (Transitions, Closed Gate, Confidence, Task Dedupe)
    // =========================================================================
    const openTasks = await this.hubspotService.getOpenTasksForDeal(
      orgId,
      deal.id,
    );
    const evalResult = this.validationService.evaluateBusinessRules({
      extraction: resolvedExtraction,
      deal,
      pipelineConfig,
      confidenceMin: call.org.confidenceMin,
      openTasks,
    });

    if (evalResult.decision === 'NEEDS_REVIEW') {
      await this.routeToReview({
        orgId,
        callId,
        reason: evalResult.reason,
        expectedDealStage: deal.dealstage,
        candidateDeals: null,
        proposal: resolvedExtraction as unknown as Record<string, unknown>,
        failureReason: evalResult.details,
      });
      return { status: CallStatus.NEEDS_REVIEW };
    }

    // If org has autoWrite disabled, route valid proposals to review queue for 1-click approval
    if (!call.org.autoWrite) {
      await this.routeToReview({
        orgId,
        callId,
        reason: ReviewReason.LOW_CONFIDENCE,
        expectedDealStage: deal.dealstage,
        candidateDeals: null,
        proposal: resolvedExtraction as unknown as Record<string, unknown>,
        failureReason: 'Org autoWrite is disabled; awaiting human approval.',
      });
      return { status: CallStatus.NEEDS_REVIEW };
    }

    // =========================================================================
    // STAGE 5: Execute Crash-Safe HubSpot Writes
    // =========================================================================
    await this.crmWriter.executeCallWrites({
      orgId,
      callId,
      dealId: deal.id,
      callTitle: call.title,
      callStartedAt: call.startedAt,
      ownerId: call.hostUser?.hubspotOwnerId ?? null,
      contactIds: call.matchedContactIds,
      companyId: call.matchedCompanyId,
      extraction: resolvedExtraction,
      shouldUpdateStage: evalResult.shouldUpdateStage,
      targetStageId: evalResult.targetStageId,
      shouldCreateTask: evalResult.shouldCreateTask,
    });

    await this.prisma.call.update({
      where: { id: callId },
      data: {
        status: CallStatus.WRITTEN,
        failureReason: null,
      },
    });

    this.logger.log({
      msg: 'Processed call end-to-end and updated HubSpot',
      orgId,
      callId,
      dealId: deal.id,
      durationMs: Date.now() - startMs,
    });

    return { status: CallStatus.WRITTEN };
  }

  private async routeToReview(params: {
    orgId: string;
    callId: string;
    reason: ReviewReason;
    expectedDealStage: string | null;
    candidateDeals: unknown;
    proposal: Record<string, unknown>;
    failureReason: string;
    matchedContactIds?: string[];
    matchedCompanyId?: string | null;
    matchMethod?: Call['matchMethod'];
  }): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.reviewItem.create({
        data: {
          orgId: params.orgId,
          callId: params.callId,
          reason: params.reason,
          expectedDealStage: params.expectedDealStage,
          candidateDeals: params.candidateDeals ?? Prisma.JsonNull,
          proposal: params.proposal as Prisma.InputJsonValue,
          status: 'OPEN',
        },
      }),
      this.prisma.call.update({
        where: { id: params.callId },
        data: {
          status: CallStatus.NEEDS_REVIEW,
          failureReason: params.failureReason,
          ...(params.matchedContactIds
            ? { matchedContactIds: params.matchedContactIds }
            : {}),
          ...(params.matchedCompanyId !== undefined
            ? { matchedCompanyId: params.matchedCompanyId }
            : {}),
          ...(params.matchMethod !== undefined
            ? { matchMethod: params.matchMethod }
            : {}),
        },
      }),
    ]);

    this.logger.log({
      msg: 'Routed call to human review queue',
      orgId: params.orgId,
      callId: params.callId,
      reason: params.reason,
      details: params.failureReason,
    });
  }

  @OnWorkerEvent('failed')
  async onJobFailed(job: Job<ProcessCallJobData> | undefined, err: Error) {
    if (!job) return;
    this.logger.error({
      msg: 'Call processing job failed',
      callId: job.data.callId,
      orgId: job.data.orgId,
      attempt: job.attemptsMade,
      error: err.message,
    });

    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await this.prisma.call.update({
        where: { id: job.data.callId },
        data: {
          status: CallStatus.FAILED,
          failureReason: `Exhausted retries: ${err.message}`,
        },
      });
    }
  }
}
