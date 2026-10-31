import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  RawExtraction,
  RawExtractionSchema,
  ResolvedExtraction,
  TranscriptTurn,
} from './schema/extraction.schema';
import {
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionPromptContext,
  buildExtractionUserPrompt,
} from './prompts/extraction.prompt';
import { repairLlmJson } from './json-repair.util';
import { verifyAndResolveExtraction } from '../validation/evidence-and-date.validator';

export type ExtractionAttemptOutcome =
  | {
      ok: true;
      raw: RawExtraction;
      resolved: ResolvedExtraction;
      attemptsUsed: number;
    }
  | {
      ok: false;
      errors: string[];
      partialRaw: unknown;
      attemptsUsed: number;
    };

@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);
  private readonly anthropic: Anthropic;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.anthropic = new Anthropic({
      apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY'),
    });
    this.model = this.config.get<string>(
      'ANTHROPIC_MODEL',
      'claude-sonnet-4-20250514',
    );
  }

  /**
   * Executes extraction with deterministic JSON repair, evidence verification,
   * and at most 1 self-correcting retry on invalid schema or fabricated quotes.
   */
  async extractAndVerifyCall(
    promptCtx: ExtractionPromptContext,
    turns: TranscriptTurn[],
    callStartedAt: Date,
  ): Promise<ExtractionAttemptOutcome> {
    let feedbackErrors: string[] = [];
    let lastParsed: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const userPrompt = buildExtractionUserPrompt(promptCtx, feedbackErrors);

      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 2048,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const textBlock = response.content.find((block) => block.type === 'text');
      const rawText =
        textBlock && textBlock.type === 'text' ? textBlock.text : '';

      // Step 1: Parse & Deterministically Repair JSON
      try {
        lastParsed = repairLlmJson(rawText);
      } catch (err) {
        feedbackErrors = [`JSON syntax error: ${(err as Error).message}`];
        this.logger.warn({
          msg: 'LLM output failed JSON repair',
          attempt,
          feedbackErrors,
        });
        continue;
      }

      // Step 2: Validate against Zod RawExtractionSchema
      const zodResult = RawExtractionSchema.safeParse(lastParsed);
      if (!zodResult.success) {
        feedbackErrors = zodResult.error.issues.map(
          (i) => `${i.path.join('.') || 'root'}: ${i.message}`,
        );
        this.logger.warn({
          msg: 'LLM output failed Zod schema check',
          attempt,
          feedbackErrors,
        });
        continue;
      }

      // Step 3: Verify turn_id evidence quotes, external speaker rule, and resolve relative dates
      const verification = verifyAndResolveExtraction(
        zodResult.data,
        turns,
        callStartedAt,
      );
      if (!verification.valid || !verification.resolved) {
        feedbackErrors = verification.reasons;
        this.logger.warn({
          msg: 'LLM output failed evidence/date verification',
          attempt,
          feedbackErrors,
        });
        continue;
      }

      return {
        ok: true,
        raw: zodResult.data,
        resolved: verification.resolved,
        attemptsUsed: attempt,
      };
    }

    return {
      ok: false,
      errors: feedbackErrors,
      partialRaw: lastParsed,
      attemptsUsed: 2,
    };
  }
}
