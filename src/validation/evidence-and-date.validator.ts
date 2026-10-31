import * as chrono from 'chrono-node';
import { z } from 'zod';
import {
  EvidenceQuoteSchema,
  RawExtraction,
  ResolvedExtraction,
  TranscriptTurn,
} from '../extraction/schema/extraction.schema';

export type EvidenceQuote = z.infer<typeof EvidenceQuoteSchema>;

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
  resolved?: ResolvedExtraction;
}

const FUZZY_SIMILARITY_THRESHOLD = 0.85;
const MAX_FUTURE_WINDOW_DAYS = 180;

/**
 * Normalizes case, strips punctuation, expands common English contractions,
 * and collapses whitespace so ASR punctuation differences do not fail valid quotes.
 */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\bweve\b/g, 'we have')
    .replace(/\bwell\b/g, 'we will')
    .replace(/\byoure\b/g, 'you are')
    .replace(/\btheyre\b/g, 'they are')
    .replace(/\bcant\b/g, 'cannot')
    .replace(/\bwont\b/g, 'will not')
    .replace(/\bdont\b/g, 'do not')
    .replace(/\bdoesnt\b/g, 'does not')
    .replace(/\bdidnt\b/g, 'did not')
    .replace(/\blets\b/g, 'let us')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks if `normQuote` appears inside `normTurn` either as a direct normalized
 * substring OR with a sliding-window token overlap >= threshold (default 0.85).
 */
export function matchesTranscriptTurn(
  turnText: string,
  quoteText: string,
  threshold = FUZZY_SIMILARITY_THRESHOLD,
): boolean {
  const normTurn = normalizeText(turnText);
  const normQuote = normalizeText(quoteText);

  if (!normQuote || !normTurn) {
    return false;
  }

  // Fast path: exact normalized substring
  if (normTurn.includes(normQuote)) {
    return true;
  }

  const turnTokens = normTurn.split(' ');
  const quoteTokens = normQuote.split(' ');

  if (quoteTokens.length < 3 || turnTokens.length < quoteTokens.length) {
    return false;
  }

  // Sliding window token overlap across the turn
  const windowSize = quoteTokens.length;
  for (let start = 0; start <= turnTokens.length - windowSize; start++) {
    let matches = 0;
    for (let i = 0; i < windowSize; i++) {
      if (turnTokens[start + i] === quoteTokens[i]) {
        matches++;
      }
    }
    if (matches / windowSize >= threshold) {
      return true;
    }
  }

  return false;
}

/**
 * Adds N business days (skipping Saturday and Sunday) to a reference UTC Date.
 */
export function addBusinessDays(
  referenceDate: Date,
  businessDaysToAdd: number,
): Date {
  const result = new Date(referenceDate.getTime());
  let added = 0;

  while (added < businessDaysToAdd) {
    result.setUTCDate(result.getUTCDate() + 1);
    const dayOfWeek = result.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      added++;
    }
  }

  return result;
}

/**
 * Verifies every evidence quote against its indexed turnId, enforces external speaker
 * attribution for stage transitions, and resolves relative dates against callStartedAt.
 */
export function verifyAndResolveExtraction(
  raw: RawExtraction,
  turns: TranscriptTurn[],
  callStartedAt: Date,
): ValidationResult {
  const reasons: string[] = [];
  const turnMap = new Map<number, TranscriptTurn>(
    turns.map((t) => [t.turnId, t]),
  );

  const verifyQuotes = (
    quotes: EvidenceQuote[],
    requireExternalSpeaker: boolean,
    fieldLabel: string,
  ): void => {
    let hasExternalSupport = false;

    for (const q of quotes) {
      const turn = turnMap.get(q.turn_id);
      if (!turn) {
        reasons.push(
          `${fieldLabel}: Referenced turn_id #${q.turn_id} does not exist in transcript (valid range: 0..${Math.max(0, turns.length - 1)}).`,
        );
        continue;
      }

      if (!matchesTranscriptTurn(turn.text, q.exact_quote)) {
        reasons.push(
          `${fieldLabel}: Quote "${q.exact_quote}" was not found in turn #${q.turn_id} ("${turn.text}").`,
        );
        continue;
      }

      if (turn.isExternal) {
        hasExternalSupport = true;
      }
    }

    if (requireExternalSpeaker && quotes.length > 0 && !hasExternalSupport) {
      reasons.push(
        `${fieldLabel}: Stage changes require at least one verified quote from an EXTERNAL_PROSPECT turn; only INTERNAL_REP turns were cited.`,
      );
    }
  };

  // 1. Verify stage_proposal quotes + enforce external buyer evidence
  if (raw.stage_proposal.new_stage_id !== null) {
    if (raw.stage_proposal.evidence.length === 0) {
      reasons.push(
        'stage_proposal: Proposing a new_stage_id requires at least one evidence quote.',
      );
    } else {
      verifyQuotes(raw.stage_proposal.evidence, true, 'stage_proposal');
    }
  }

  // 2. Verify next_step quotes + resolve relative due_date_raw in code
  let resolvedNextStep: ResolvedExtraction['next_step'] = null;

  if (raw.next_step !== null) {
    verifyQuotes(raw.next_step.evidence, false, 'next_step');

    let parsedDate: Date | null = null;
    let dueDateInferred = false;

    if (
      raw.next_step.due_date_raw &&
      raw.next_step.due_date_raw.trim().length > 0
    ) {
      parsedDate = chrono.parseDate(raw.next_step.due_date_raw, callStartedAt, {
        forwardDate: true,
      });
    }

    // Fallback: if no timeframe was stated or chrono could not parse it, default to +3 business days
    if (!parsedDate) {
      dueDateInferred = true;
      parsedDate = addBusinessDays(callStartedAt, 3);
    }

    // Normalize due time to 17:00 UTC if chrono set midnight/call time and check sanity window
    const maxFutureMs =
      callStartedAt.getTime() + MAX_FUTURE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    if (parsedDate.getTime() <= callStartedAt.getTime()) {
      reasons.push(
        `next_step: Resolved due date (${parsedDate.toISOString()}) from phrase "${raw.next_step.due_date_raw}" is not in the future relative to call timestamp (${callStartedAt.toISOString()}).`,
      );
    } else if (parsedDate.getTime() > maxFutureMs) {
      reasons.push(
        `next_step: Resolved due date (${parsedDate.toISOString()}) exceeds the ${MAX_FUTURE_WINDOW_DAYS}-day maximum future window.`,
      );
    }

    resolvedNextStep = {
      action: raw.next_step.action,
      owner: raw.next_step.owner,
      due_date_raw: raw.next_step.due_date_raw,
      due_date_iso: parsedDate.toISOString(),
      due_date_inferred: dueDateInferred,
      evidence: raw.next_step.evidence,
    };
  }

  if (reasons.length > 0) {
    return { valid: false, reasons };
  }

  return {
    valid: true,
    reasons: [],
    resolved: {
      ...raw,
      next_step: resolvedNextStep,
    },
  };
}
