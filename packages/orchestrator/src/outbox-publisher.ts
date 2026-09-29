import { buildCard, renderCardText, type DiscordDeliveryResult } from '@job-agent/notifications';
import { silentLogger, type StructuredLogger } from '@job-agent/observability';
import type { TrackingStores } from '@job-agent/tracking';

import { inQuietHours, type QuietHours } from './quiet-hours.js';

export interface NotificationChannel {
  sendMessage(content: string): Promise<DiscordDeliveryResult>;
}

export type OutboxPublisherOptions = {
  stores: TrackingStores;
  channel: NotificationChannel | null;
  logger?: StructuredLogger;
  quietHours?: QuietHours | null;
  batchSize?: number;
  /**
   * Loads the text of an email-application review at the moment it is delivered.
   *
   * The review is the one message that has to contain applicant wording, because approving a
   * message you cannot read is not approval. Keeping it out of the outbox row means the durable,
   * queryable, loggable object holds a reference and a part number, and the wording is fetched from
   * local encrypted storage only to be handed straight to the chat service. Returning null — a
   * superseded or unreadable review — falls back to a card that says so and shows nothing.
   */
  reviewText?: (reference: { reviewRef: string; chunkIndex: number }) => Promise<string | null>;
};

export type PublishSummary = {
  attempted: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  skippedReason: string | null;
};

function backoffMs(attempts: number): number {
  const base = Math.min(2 ** Math.max(attempts - 1, 0) * 30_000, 3_600_000);
  return base + Math.floor(Math.random() * 5_000);
}

/**
 * Transactional-outbox delivery. Events are written in the same transaction as the state change
 * that caused them, so a notification is never lost and never sent twice for the same dedupe key.
 */
export class OutboxPublisher {
  private readonly logger: StructuredLogger;

  constructor(private readonly options: OutboxPublisherOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  async publishBatch(now = new Date()): Promise<PublishSummary> {
    const summary: PublishSummary = {
      attempted: 0,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      skippedReason: null,
    };
    const { channel } = this.options;
    if (channel === null) {
      summary.skippedReason = 'notifications_not_configured';
      return summary;
    }
    const runtime = await this.options.stores.runtime.get();
    if (runtime.paused) {
      summary.skippedReason = 'agent_paused';
      return summary;
    }
    if (inQuietHours(now, this.options.quietHours ?? null)) {
      summary.skippedReason = 'quiet_hours';
      return summary;
    }

    const events = await this.options.stores.outbox.claimBatch(now, this.options.batchSize ?? 10);
    for (const event of events) {
      summary.attempted += 1;
      const content = await this.renderEvent(event);
      const result = await channel.sendMessage(content);
      if (result.status === 'delivered') {
        await this.options.stores.outbox.markPublished(event.id, now);
        summary.delivered += 1;
        continue;
      }
      const attemptsUsed = event.attempts;
      const exhausted = attemptsUsed >= event.maxAttempts;
      const deadLetter = result.status === 'permanent' || exhausted;
      const waitMs =
        result.status === 'retry' ? Math.max(result.retryAfterMs, backoffMs(attemptsUsed)) : 0;
      await this.options.stores.outbox.markFailed({
        id: event.id,
        errorCode: result.errorCode,
        retryAt: deadLetter ? null : new Date(now.getTime() + waitMs),
        deadLetter,
        now,
      });
      if (deadLetter) summary.deadLettered += 1;
      else summary.retried += 1;
      this.logger.log(deadLetter ? 'error' : 'warn', 'Notification delivery failed', {
        eventType: event.eventType,
        errorCode: result.errorCode,
        attempts: attemptsUsed,
        deadLetter,
      });
    }
    return summary;
  }

  /** The card text for one event, hydrating an email review from local storage as it goes out. */
  private async renderEvent(event: {
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<string> {
    if (event.eventType === 'EMAIL_APPLICATION_REVIEW' && this.options.reviewText !== undefined) {
      const reviewRef = event.payload.reviewRef;
      const chunkIndex = event.payload.chunkIndex;
      if (typeof reviewRef === 'string' && typeof chunkIndex === 'number') {
        const text = await this.options.reviewText({ reviewRef, chunkIndex });
        if (text !== null) return text;
      }
    }
    return renderCardText(buildCard(event));
  }
}
