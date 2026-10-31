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
