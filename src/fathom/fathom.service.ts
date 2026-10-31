/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import axios from 'axios';
import { PrismaService } from '../common/prisma/prisma.service';
import { CryptoService } from '../common/crypto/crypto.service';
import {
  FathomWebhookPayload,
  FathomWebhookPayloadSchema,
  FathomApiTranscriptResponseSchema,
} from './dto/fathom.dto';
import { TranscriptTurn } from '../extraction/schema/extraction.schema';

export const CALLS_QUEUE = 'calls';

export interface ClassifiedAttendee {
  name: string;
  email: string | null;
  isExternal: boolean;
}

@Injectable()
export class FathomService {
  private readonly logger = new Logger(FathomService.name);
  private readonly fathomBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    @InjectQueue(CALLS_QUEUE) private readonly callsQueue: Queue,
  ) {
    this.fathomBaseUrl = this.config.get<string>(
      'FATHOM_API_BASE_URL',
      'https://api.fathom.video/external/v1',
    );
  }

  /**
   * 1. Validates signature, deduplicates webhook & multi-seat recording, and enqueues job
   */
  async handleWebhook(
    fathomWebhookKey: string,
    rawBody: Buffer | undefined,
    signatureHeader: string | undefined,
    body: unknown,
  ): Promise<{ status: string; callId?: string }> {
    const org = await this.prisma.org.findUnique({
      where: { fathomWebhookKey },
    });

    if (!org || !org.fathomSecretEnc) {
      throw new NotFoundException(
        'Unknown webhook endpoint or unconfigured Fathom secret.',
      );
    }

    const secret = this.crypto.decrypt(org.fathomSecretEnc);
    if (
      !rawBody ||
      !signatureHeader ||
      !this.crypto.verifyHmacSignature(rawBody, secret, signatureHeader)
    ) {
      throw new UnauthorizedException('Invalid Fathom webhook signature.');
    }

    const parsed = FathomWebhookPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid Fathom webhook payload',
        errors: parsed.error.flatten(),
      });
    }

    const payload: FathomWebhookPayload = parsed.data;
    const startedAt = new Date(payload.call.started_at);
    const classifiedAttendees = this.classifyAttendees(
      payload.call.attendees,
      org.internalDomains,
    );

    const meetingFingerprint = this.computeMeetingFingerprint(
      org.id,
      startedAt,
      classifiedAttendees,
      payload.call.id,
    );

    // Resolve host User ID if host_email matches an org member
    const hostUser = payload.call.host_email
      ? await this.prisma.user.findUnique({
          where: {
            orgId_email: {
              orgId: org.id,
              email: payload.call.host_email.toLowerCase(),
            },
          },
          select: { id: true },
        })
      : null;

    try {
      const call = await this.prisma.$transaction(async (tx) => {
        // Step A: Insert WebhookEvent (throws P2002 if externalId already received)
        await tx.webhookEvent.create({
          data: {
            orgId: org.id,
            source: 'fathom',
            externalId: payload.event_id,
            type: payload.event_type,
          },
        });

        // Step B: Create Call (throws P2002 if fathomCallId or meetingFingerprint already exists)
        return tx.call.create({
          data: {
            orgId: org.id,
            hostUserId: hostUser?.id ?? null,
            fathomCallId: payload.call.id,
            meetingFingerprint,
            title: payload.call.title ?? null,
            startedAt,
            durationSeconds: payload.call.duration_seconds ?? null,
            attendees: classifiedAttendees as unknown as Prisma.InputJsonValue,
            status: 'RECEIVED',
          },
        });
      });

      // Enqueue BullMQ job with deterministic jobId = call.id
      await this.callsQueue.add(
        'process-call',
        { callId: call.id, orgId: org.id },
        {
          jobId: call.id,
          attempts: 4,
          backoff: { type: 'exponential', delay: 3000 },
          removeOnComplete: 1000,
        },
      );

      this.logger.log({
        msg: 'Call webhook ingested and queued',
        orgId: org.id,
        callId: call.id,
        fathomCallId: payload.call.id,
      });

      return { status: 'queued', callId: call.id };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.log({
          msg: 'Idempotent duplicate webhook or multi-seat recording skipped',
          orgId: org.id,
          fathomCallId: payload.call.id,
          eventId: payload.event_id,
        });
        return { status: 'duplicate_ignored' };
      }
      throw err;
    }
  }

  /**
   * 2. Fetches transcript from Fathom API and indexes utterances into speaker-tagged turns
   */
  async fetchAndNormalizeTranscript(
    orgId: string,
    fathomCallId: string,
  ): Promise<TranscriptTurn[]> {
    const org = await this.prisma.org.findUniqueOrThrow({
      where: { id: orgId },
      select: { fathomApiKeyEnc: true, internalDomains: true },
    });

    if (!org.fathomApiKeyEnc) {
      throw new BadRequestException(
        `Org ${orgId} has no configured Fathom API key.`,
      );
    }

    const apiKey = this.crypto.decrypt(org.fathomApiKeyEnc);
    const response = await axios.get(
      `${this.fathomBaseUrl}/calls/${fathomCallId}/transcript`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15_000,
      },
    );

    const parsed = FathomApiTranscriptResponseSchema.parse(response.data);
    const internalSet = new Set(
      org.internalDomains.map((d) => d.toLowerCase()),
    );

    return parsed.utterances.map((u, idx) => {
      const email = u.speaker_email?.toLowerCase() ?? null;
      const domain = email ? email.split('@')[1] : null;
      const isExternal = domain ? !internalSet.has(domain) : true;

      return {
        turnId: idx,
        speakerName: u.speaker_name,
        speakerEmail: email,
        isExternal,
        timestampMs: u.timestamp_ms,
        text: u.text.trim(),
      };
    });
  }

  /**
   * Formats indexed turns into the prompt string passed to Claude:
   * [#14 | EXTERNAL | Sara (sara@client.com)] We can sign the contract next Friday.
   */
  formatTurnsForPrompt(turns: TranscriptTurn[]): string {
    return turns
      .map((t) => {
        const roleTag = t.isExternal ? 'EXTERNAL_PROSPECT' : 'INTERNAL_REP';
        const speakerLabel = t.speakerEmail
          ? `${t.speakerName} (${t.speakerEmail})`
          : t.speakerName;
        return `[#${t.turnId} | ${roleTag} | ${speakerLabel}] ${t.text}`;
      })
      .join('\n');
  }

  private classifyAttendees(
    attendees: { name: string; email?: string | null }[],
    internalDomains: string[],
  ): ClassifiedAttendee[] {
    const internalSet = new Set(internalDomains.map((d) => d.toLowerCase()));

    return attendees.map((a) => {
      const email = a.email ? a.email.toLowerCase().trim() : null;
      const domain = email ? email.split('@')[1] : null;
      const isExternal = domain ? !internalSet.has(domain) : false;

      return {
        name: a.name,
        email,
        isExternal,
      };
    });
  }

  /**
   * Computes SHA-256(orgId + 5min_startedAt_bucket + sorted_external_emails)
   * If two reps on the same call both run Fathom, both webhooks produce the same fingerprint.
   */
  private computeMeetingFingerprint(
    orgId: string,
    startedAt: Date,
    attendees: ClassifiedAttendee[],
    fallbackFathomId: string,
  ): string {
    const fiveMinBucket = Math.floor(startedAt.getTime() / (5 * 60 * 1000));
    const externalEmails = attendees
      .filter((a) => a.isExternal && a.email)
      .map((a) => a.email!)
      .sort();

    const identityKey =
      externalEmails.length > 0
        ? externalEmails.join(',')
        : `internal:${fallbackFathomId}`;

    return createHash('sha256')
      .update(`${orgId}:${fiveMinBucket}:${identityKey}`)
      .digest('hex');
  }
}
