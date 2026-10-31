import { z } from 'zod';

export const FathomWebhookAttendeeSchema = z.object({
  name: z.string().default('Unknown Speaker'),
  email: z.string().email().nullable().optional(),
});

export const FathomWebhookPayloadSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.literal('call.recording_ready'),
  call: z.object({
    id: z.string().min(1),
    title: z.string().nullable().optional(),
    started_at: z.string().datetime(),
    duration_seconds: z.number().int().nonnegative().optional(),
    host_email: z.string().email().optional(),
    attendees: z.array(FathomWebhookAttendeeSchema).default([]),
  }),
});

export type FathomWebhookPayload = z.infer<typeof FathomWebhookPayloadSchema>;

export const FathomApiUtteranceSchema = z.object({
  speaker_name: z.string(),
  speaker_email: z.string().email().nullable().optional(),
  timestamp_ms: z.number().int().nonnegative(),
  text: z.string(),
});

export const FathomApiTranscriptResponseSchema = z.object({
  call_id: z.string(),
  utterances: z.array(FathomApiUtteranceSchema),
});
