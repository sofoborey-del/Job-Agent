import type { DiscordDeliveryResult } from '@job-agent/notifications';
import type {
  OutboxEventInput,
  OutboxEventRecord,
  OutboxStore,
  RuntimeState,
  RuntimeStateStore,
  TrackingStores,
} from '@job-agent/tracking';
import { describe, expect, it } from 'vitest';

import { OutboxPublisher, type NotificationChannel } from './outbox-publisher.js';
import { inQuietHours } from './quiet-hours.js';

class MemoryOutbox implements OutboxStore {
  readonly events: OutboxEventRecord[] = [];
  readonly published: string[] = [];
  readonly failures: Array<{ id: string; errorCode: string; deadLetter: boolean }> = [];

  enqueue(event: OutboxEventInput, now: Date): Promise<boolean> {
    if (this.events.some((existing) => existing.dedupeKey === event.dedupeKey)) {
      return Promise.resolve(false);
    }
    this.events.push({
      id: `event-${String(this.events.length + 1)}`,
      eventType: event.eventType,
      channel: event.channel,
      dedupeKey: event.dedupeKey,
      correlationId: event.correlationId,
      payload: event.payload,
      attempts: 0,
      maxAttempts: event.maxAttempts ?? 6,
      availableAt: (event.availableAt ?? now).toISOString(),
      lastErrorCode: null,
      deadLetteredAt: null,
    });
    return Promise.resolve(true);
  }

  claimBatch(_now: Date, limit: number): Promise<OutboxEventRecord[]> {
    const claimable = this.events
      .filter((event) => event.deadLetteredAt === null && !this.published.includes(event.id))
      .slice(0, limit);
    for (const event of claimable) event.attempts += 1;
    return Promise.resolve(claimable);
  }

  markPublished(id: string): Promise<void> {
    this.published.push(id);
    return Promise.resolve();
  }

  markFailed(input: { id: string; errorCode: string; deadLetter: boolean }): Promise<void> {
    this.failures.push(input);
    if (input.deadLetter) {
      const event = this.events.find((candidate) => candidate.id === input.id);
      if (event !== undefined) event.deadLetteredAt = new Date().toISOString();
    }
    return Promise.resolve();
  }

  deadLetters(): Promise<OutboxEventRecord[]> {
    return Promise.resolve(this.events.filter((event) => event.deadLetteredAt !== null));
  }

  pendingCount(): Promise<number> {
    return Promise.resolve(this.events.length - this.published.length);
  }
}

class MemoryRuntime implements RuntimeStateStore {
  private state: RuntimeState = {
    paused: false,
    pausedReason: null,
    pausedAt: null,
    updatedAt: new Date().toISOString(),
  };

  get(): Promise<RuntimeState> {
    return Promise.resolve(this.state);
  }

  setPaused(paused: boolean, reason: string | null, now: Date): Promise<RuntimeState> {
    this.state = {
      paused,
      pausedReason: reason,
      pausedAt: paused ? now.toISOString() : null,
      updatedAt: now.toISOString(),
    };
    return Promise.resolve(this.state);
  }
}

function storesWith(outbox: MemoryOutbox, runtime: MemoryRuntime): TrackingStores {
  return { outbox, runtime } as unknown as TrackingStores;
}

function channelReturning(...results: DiscordDeliveryResult[]): NotificationChannel & {
  sent: string[];
} {
  const sent: string[] = [];
  let index = 0;
  return {
    sent,
    sendMessage: (content: string) => {
      sent.push(content);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return Promise.resolve(result ?? { status: 'delivered' });
    },
  };
}

const sampleEvent: OutboxEventInput = {
  eventType: 'JOB_MATCHED',
  channel: 'discord',
  dedupeKey: 'job_matched:1',
  correlationId: 'correlation-1',
  payload: { title: 'Officer', employer: 'Example Council', score: 72 },
};

describe('quiet hours', () => {
  it('covers a window that wraps midnight', () => {
    const quiet = { startHour: 22, endHour: 7, timeZone: 'Europe/London' };
    expect(inQuietHours(new Date('2026-09-25T22:30:00+01:00'), quiet)).toBe(true);
    expect(inQuietHours(new Date('2026-09-26T03:00:00+01:00'), quiet)).toBe(true);
    expect(inQuietHours(new Date('2026-09-26T09:00:00+01:00'), quiet)).toBe(false);
    expect(inQuietHours(new Date('2026-09-26T09:00:00+01:00'), null)).toBe(false);
  });
});

describe('outbox publishing', () => {
  it('sends a queued event once and marks it published', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(sampleEvent, new Date());
    const channel = channelReturning({ status: 'delivered' });
    const publisher = new OutboxPublisher({
      stores: storesWith(outbox, new MemoryRuntime()),
      channel,
    });
    const summary = await publisher.publishBatch(new Date('2026-09-25T12:00:00.000Z'));
    expect(summary.delivered).toBe(1);
    expect(channel.sent[0]).toContain('Officer');
    const again = await publisher.publishBatch(new Date('2026-09-25T12:01:00.000Z'));
    expect(again.attempted).toBe(0);
  });

  it('never queues the same event twice', async () => {
    const outbox = new MemoryOutbox();
    expect(await outbox.enqueue(sampleEvent, new Date())).toBe(true);
    expect(await outbox.enqueue(sampleEvent, new Date())).toBe(false);
  });

  it('retries a rate limited send and dead-letters a permanent rejection', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(sampleEvent, new Date());
    const retrying = new OutboxPublisher({
      stores: storesWith(outbox, new MemoryRuntime()),
      channel: channelReturning({ status: 'retry', errorCode: 'rate_limited', retryAfterMs: 5000 }),
    });
    const retried = await retrying.publishBatch(new Date());
    expect(retried.retried).toBe(1);
    expect(outbox.failures[0]?.deadLetter).toBe(false);

    const permanent = new OutboxPublisher({
      stores: storesWith(outbox, new MemoryRuntime()),
      channel: channelReturning({ status: 'permanent', errorCode: 'http_403' }),
    });
    const failed = await permanent.publishBatch(new Date());
    expect(failed.deadLettered).toBe(1);
    expect((await outbox.deadLetters()).length).toBe(1);
  });

  it('sends nothing while the agent is paused or during quiet hours', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(sampleEvent, new Date());
    const runtime = new MemoryRuntime();
    await runtime.setPaused(true, 'testing', new Date());
    const paused = await new OutboxPublisher({
      stores: storesWith(outbox, runtime),
      channel: channelReturning({ status: 'delivered' }),
    }).publishBatch(new Date());
    expect(paused.skippedReason).toBe('agent_paused');

    const quiet = await new OutboxPublisher({
      stores: storesWith(outbox, new MemoryRuntime()),
      channel: channelReturning({ status: 'delivered' }),
      quietHours: { startHour: 22, endHour: 7, timeZone: 'Europe/London' },
    }).publishBatch(new Date('2026-09-25T23:30:00+01:00'));
    expect(quiet.skippedReason).toBe('quiet_hours');
  });

  it('does nothing at all when no notification channel is configured', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(sampleEvent, new Date());
    const summary = await new OutboxPublisher({
      stores: storesWith(outbox, new MemoryRuntime()),
      channel: null,
    }).publishBatch(new Date());
    expect(summary).toMatchObject({ attempted: 0, skippedReason: 'notifications_not_configured' });
  });
});
