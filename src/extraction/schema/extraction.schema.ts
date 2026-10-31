import { z } from 'zod';

export const TranscriptTurnSchema = z.object({
  turnId: z.number().int().nonnegative(),
  speakerName: z.string(),
  speakerEmail: z.string().email().nullable(),
  isExternal: z.boolean(),
  timestampMs: z.number().int().nonnegative(),
  text: z.string(),
});

export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

export const EvidenceQuoteSchema = z.object({
  turn_id: z.number().int().nonnegative(),
  exact_quote: z.string().min(1),
});

export type EvidenceQuote = z.infer<typeof EvidenceQuoteSchema>;

export const EvidenceItemSchema = EvidenceQuoteSchema;
export type EvidenceItem = EvidenceQuote;

export const StageProposalSchema = z.object({
  new_stage_id: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
  evidence: z.array(EvidenceItemSchema).default([]),
});

export const RawNextStepSchema = z.object({
  action: z.string().min(1),
  owner: z.enum(['rep', 'prospect']),
  due_date_raw: z.string().min(1).nullable().default(null),
  evidence: z.array(EvidenceItemSchema).min(1),
});

export const RawExtractionSchema = z
  .object({
    summary: z.string().min(10),
    key_points: z.array(z.string().min(1)).min(1).max(8),
    stage_proposal: StageProposalSchema,
    next_step: RawNextStepSchema.nullable().default(null),
    extracted_stage_properties: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .default({}),
    risks: z.array(z.string()).default([]),
    no_update_reason: z.string().nullable().default(null),
  })
  .superRefine((val, ctx) => {
    if (
      val.stage_proposal.new_stage_id === null &&
      val.next_step === null &&
      (!val.no_update_reason || val.no_update_reason.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['no_update_reason'],
        message:
          'no_update_reason is required when both new_stage_id and next_step are null.',
      });
    }
  });

export type RawExtraction = z.infer<typeof RawExtractionSchema>;

export const ResolvedNextStepSchema = RawNextStepSchema.extend({
  // Always resolved in code: parsed from due_date_raw, or +3 business days fallback
  due_date_iso: z.string().datetime(),
  // true when due_date_iso came from the fallback rather than a phrase spoken on the call
  due_date_inferred: z.boolean(),
});

export type ResolvedNextStep = z.infer<typeof ResolvedNextStepSchema>;

export interface ResolvedExtraction extends Omit<RawExtraction, 'next_step'> {
  next_step: ResolvedNextStep | null;
}
