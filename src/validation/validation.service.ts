/* eslint-disable @typescript-eslint/no-base-to-string */
import { Injectable, Logger } from '@nestjs/common';
import { ReviewReason } from '@prisma/client';
import { ResolvedExtraction } from '../extraction/schema/extraction.schema';
import {
  HubSpotDealRecord,
  HubSpotOpenTask,
  OrgPipelineConfig,
  PipelineStageConfig,
} from '../hubspot/hubspot.service';
import { normalizeText } from './evidence-and-date.validator';

export interface PipelineEvaluationInput {
  extraction: ResolvedExtraction;
  deal: HubSpotDealRecord;
  pipelineConfig: OrgPipelineConfig;
  confidenceMin: number;
  openTasks: HubSpotOpenTask[];
}

export type PipelineEvaluationResult =
  | {
      decision: 'READY_TO_WRITE';
      shouldUpdateStage: boolean;
      targetStageId: string | null;
      shouldCreateTask: boolean;
      duplicateTaskId: string | null;
    }
  | {
      decision: 'NEEDS_REVIEW';
      reason: ReviewReason;
      details: string;
    };

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  evaluateBusinessRules(
    input: PipelineEvaluationInput,
  ): PipelineEvaluationResult {
    const { extraction, deal, pipelineConfig, confidenceMin, openTasks } =
      input;
    const proposedStageId = extraction.stage_proposal.new_stage_id;

    let shouldUpdateStage = false;
    let targetStageId: string | null = null;

    // =========================================================================
    // 1. Evaluate Stage Transition, Closed Gate, Required Props & Confidence
    // =========================================================================
    if (proposedStageId !== null && proposedStageId !== deal.dealstage) {
      const pipeline = pipelineConfig.pipelines?.[deal.pipeline];
      if (!pipeline) {
        return {
          decision: 'NEEDS_REVIEW',
          reason: ReviewReason.INVALID_OUTPUT,
          details: `Deal pipeline "${deal.pipeline}" not found in org pipelineConfig.`,
        };
      }

      const currentStage = pipeline.stages.find((s) => s.id === deal.dealstage);
      const targetStage = pipeline.stages.find((s) => s.id === proposedStageId);

      if (!currentStage || !targetStage) {
        return {
          decision: 'NEEDS_REVIEW',
          reason: ReviewReason.INVALID_OUTPUT,
          details: `Proposed stage "${proposedStageId}" does not exist in pipeline "${pipeline.label}".`,
        };
      }

      // Rule A: Closed Won / Closed Lost ALWAYS require human review
      if (targetStage.isClosed) {
        return {
          decision: 'NEEDS_REVIEW',
          reason: ReviewReason.CLOSED_STAGE_GATE,
          details: `Target stage "${targetStage.label}" is a closed stage and requires manual approval.`,
        };
      }

      // Rule B: Stage ordering check (allow forward by 1 or 2 stages; review regressions or big jumps)
      const currentIdx = pipeline.stages.findIndex(
        (s) => s.id === currentStage.id,
      );
      const targetIdx = pipeline.stages.findIndex(
        (s) => s.id === targetStage.id,
      );
      const stageDelta = targetIdx - currentIdx;

      if (stageDelta < 0) {
        return {
          decision: 'NEEDS_REVIEW',
          reason: ReviewReason.STAGE_REGRESSION,
          details: `Proposed stage "${targetStage.label}" moves backward from "${currentStage.label}".`,
        };
      }

      if (stageDelta > 2) {
        return {
          decision: 'NEEDS_REVIEW',
          reason: ReviewReason.STAGE_REGRESSION,
          details: `Proposed stage "${targetStage.label}" skips ${stageDelta - 1} intermediate stages.`,
        };
      }

      // Rule C: Required stage properties check
      const missingProps = this.findMissingStageProperties(
        targetStage,
        deal,
        extraction.extracted_stage_properties,
      );
      if (missingProps.length > 0) {
        return {
          decision: 'NEEDS_REVIEW',
          reason: ReviewReason.MISSING_STAGE_PROPERTIES,
          details: `Target stage "${targetStage.label}" requires properties not present on the deal or call: ${missingProps.join(', ')}.`,
        };
      }

      // Rule D: Confidence threshold gate
      if (extraction.stage_proposal.confidence < confidenceMin) {
        return {
          decision: 'NEEDS_REVIEW',
          reason: ReviewReason.LOW_CONFIDENCE,
          details: `Stage confidence (${extraction.stage_proposal.confidence.toFixed(2)}) is below threshold (${confidenceMin.toFixed(2)}).`,
        };
      }

      shouldUpdateStage = true;
      targetStageId = targetStage.id;
    }

    // =========================================================================
    // 2. Deduplicate Proposed Next-Step Task Against Open Deal Tasks
    // =========================================================================
    let shouldCreateTask = false;
    let duplicateTaskId: string | null = null;

    if (extraction.next_step) {
      const existingDup = this.findDuplicateOpenTask(
        extraction.next_step.action,
        openTasks,
      );
      if (existingDup) {
        duplicateTaskId = existingDup.id;
        shouldCreateTask = false;
        this.logger.log({
          msg: 'Skipping duplicate next-step task creation',
          dealId: deal.id,
          duplicateTaskId,
          proposedAction: extraction.next_step.action,
        });
      } else {
        shouldCreateTask = true;
      }
    }

    return {
      decision: 'READY_TO_WRITE',
      shouldUpdateStage,
      targetStageId,
      shouldCreateTask,
      duplicateTaskId,
    };
  }

  private findMissingStageProperties(
    targetStage: PipelineStageConfig,
    deal: HubSpotDealRecord,
    extractedProps: Record<string, string | number | boolean>,
  ): string[] {
    const missing: string[] = [];
    const dealSnapshot: Record<string, unknown> = {
      dealname: deal.dealname,
      amount: deal.amount,
      closedate: deal.closedate,
    };

    for (const propName of targetStage.requiredProperties) {
      const existingVal = dealSnapshot[propName];
      const extractedVal = extractedProps[propName];

      const hasExisting =
        existingVal !== undefined &&
        existingVal !== null &&
        String(existingVal).trim() !== '';
      const hasExtracted =
        extractedVal !== undefined &&
        extractedVal !== null &&
        String(extractedVal).trim() !== '';

      if (!hasExisting && !hasExtracted) {
        missing.push(propName);
      }
    }

    return missing;
  }

  /**
   * Detects if an open task on the deal already represents the same action
   * using normalized substring inclusion or token Jaccard similarity >= 0.65.
   */
  private findDuplicateOpenTask(
    proposedAction: string,
    openTasks: HubSpotOpenTask[],
  ): HubSpotOpenTask | null {
    const normProposed = normalizeText(proposedAction);
    if (!normProposed) return null;

    const proposedTokens = new Set(
      normProposed.split(' ').filter((t) => t.length > 2),
    );

    for (const task of openTasks) {
      const normExisting = normalizeText(task.subject);
      if (!normExisting) continue;

      if (
        normExisting.includes(normProposed) ||
        normProposed.includes(normExisting)
      ) {
        return task;
      }

      const existingTokens = new Set(
        normExisting.split(' ').filter((t) => t.length > 2),
      );
      if (proposedTokens.size === 0 || existingTokens.size === 0) continue;

      let intersection = 0;
      for (const token of proposedTokens) {
        if (existingTokens.has(token)) intersection++;
      }

      const union = new Set([...proposedTokens, ...existingTokens]).size;
      if (intersection / union >= 0.65) {
        return task;
      }
    }

    return null;
  }
}
