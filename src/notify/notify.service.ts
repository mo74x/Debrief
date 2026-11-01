import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CrmWrite, ReviewReason } from '@prisma/client';
import axios from 'axios';
import { ResolvedExtraction } from '../extraction/schema/extraction.schema';
import { RankedDealCandidate } from '../matching/deal-matcher.service';

export interface NotifyWriteCompletedInput {
  orgId: string;
  callId: string;
  callTitle: string | null;
  dealId: string;
  dealName: string;
  slackUserId?: string | null;
  extraction: ResolvedExtraction;
  writes: CrmWrite[];
}

export interface NotifyReviewNeededInput {
  orgId: string;
  callId: string;
  reviewItemId: string;
  callTitle: string | null;
  reason: ReviewReason;
  details: string;
  slackUserId?: string | null;
  candidates?: RankedDealCandidate[];
}

@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);
  private readonly slackBotToken: string | undefined;
  private readonly slackDefaultChannel: string | undefined;
  private readonly appBaseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.slackBotToken = this.config.get<string>('SLACK_BOT_TOKEN');
    this.slackDefaultChannel = this.config.get<string>('SLACK_DEFAULT_CHANNEL');
    this.appBaseUrl = this.config.get<string>(
      'APP_BASE_URL',
      'http://localhost:3000',
    );
  }

  /**
   * 1. Notifies the rep when HubSpot has been updated, including before/after stage and Undo action
   */
  async notifyWriteCompleted(input: NotifyWriteCompletedInput): Promise<void> {
    const channel = input.slackUserId || this.slackDefaultChannel;
    const stageWrite = input.writes.find((w) => w.type === 'STAGE');
    const taskWrite = input.writes.find((w) => w.type === 'TASK');

    const stageLine = stageWrite
      ? `*Stage Updated:* \`${(stageWrite.before as Record<string, string>)?.dealstage ?? 'previous'}\` ➔ \`${(stageWrite.after as Record<string, string>)?.dealstage}\``
      : `*Stage:* No change proposed`;

    const taskLine =
      taskWrite && input.extraction.next_step
        ? `*Next-Step Task:* ${input.extraction.next_step.action} (Due: \`${input.extraction.next_step.due_date_iso.slice(0, 10)}\`)`
        : `*Next-Step Task:* None created`;

    const undoUrl = `${this.appBaseUrl}/calls/${input.callId}/undo-all`;
    const callDetailUrl = `${this.appBaseUrl}/calls/${input.callId}`;

    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `CRM Updated: ${input.dealName}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Call:* ${input.callTitle || 'Sales Call'}\n${stageLine}\n${taskLine}\n\n*Summary:*\n${input.extraction.summary}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Undo CRM Writes', emoji: true },
            style: 'danger',
            value: input.callId,
            action_id: 'undo_call_writes',
            url: undoUrl,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Audit Log', emoji: true },
            url: callDetailUrl,
            action_id: 'view_call_audit',
          },
        ],
      },
    ];

    await this.postSlackMessage(
      channel,
      `Updated HubSpot deal "${input.dealName}" from call "${input.callTitle || 'Sales Call'}".`,
      blocks,
    );
  }

  /**
   * 2. Notifies the rep when a call is routed to the human review queue
   */
  async notifyReviewRequired(input: NotifyReviewNeededInput): Promise<void> {
    const channel = input.slackUserId || this.slackDefaultChannel;
    const reviewUrl = `${this.appBaseUrl}/review/${input.reviewItemId}`;

    const candidateText =
      input.candidates && input.candidates.length > 0
        ? `\n*Candidate Deals:*\n` +
          input.candidates
            .slice(0, 3)
            .map(
              (c, idx) => `${idx + 1}. *${c.dealName}* (Stage: \`${c.stage}\`)`,
            )
            .join('\n')
        : '';

    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `Review Needed: ${input.callTitle || 'Sales Call'}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Reason:* \`${input.reason}\`\n*Details:* ${input.details}${candidateText}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Review & Approve', emoji: true },
            style: 'primary',
            url: reviewUrl,
            action_id: 'open_review_item',
          },
        ],
      },
    ];

    await this.postSlackMessage(
      channel,
      `Call "${input.callTitle || 'Sales Call'}" needs review (${input.reason}).`,
      blocks,
    );
  }

  private async postSlackMessage(
    channel: string | undefined,
    fallbackText: string,
    blocks: unknown[],
  ): Promise<void> {
    if (!this.slackBotToken || !channel) {
      this.logger.log({
        msg: 'Slack notification skipped (no SLACK_BOT_TOKEN or channel); logged locally',
        fallbackText,
      });
      return;
    }

    try {
      await axios.post(
        'https://slack.com/api/chat.postMessage',
        {
          channel,
          text: fallbackText,
          blocks,
        },
        {
          headers: {
            Authorization: `Bearer ${this.slackBotToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 8_000,
        },
      );
    } catch (err) {
      this.logger.warn({
        msg: 'Failed to send Slack notification',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
