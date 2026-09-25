import type {
  DiscoveryService,
  JobMatchService,
  SchedulerReadiness,
  SchedulerReadinessService,
} from '@job-agent/tracking';
import { describe, expect, it } from 'vitest';

import type { OutboxPublisher } from './outbox-publisher.js';
import { DiscoveryScheduler } from './scheduler.js';

function readinessStub(sequence: SchedulerReadiness[]): {
  service: SchedulerReadinessService;
  calls: number;
} {
  const state = { calls: 0 };
  const service = {
    check: (now: Date) => {
      const result = sequence[Math.min(state.calls, sequence.length - 1)] ?? {
        ready: false,
        problems: [],
        enabledSources: 0,
        checkedAt: now.toISOString(),
      };
      state.calls += 1;
      return Promise.resolve(result);
    },
  } as unknown as SchedulerReadinessService;
  return {
    service,
    get calls() {
      return state.calls;
    },
  };
}

const notReady: SchedulerReadiness = {
  ready: false,
  problems: [
    {
      code: 'profile_incomplete',
      message: 'Finish the profile before scheduled searching starts.',
    },
  ],
  enabledSources: 1,
  checkedAt: '2026-09-25T10:00:00.000Z',
};

const ready: SchedulerReadiness = {
  ready: true,
  problems: [],
  enabledSources: 1,
  checkedAt: '2026-09-25T10:00:00.000Z',
};

function buildScheduler(readinessSequence: SchedulerReadiness[]) {
  const calls = { discovery: 0, matching: 0, publishing: 0, facts: 0 };
  const probe = readinessStub(readinessSequence);
  const scheduler = new DiscoveryScheduler({
    discovery: {
      runDue: () => {
        calls.discovery += 1;
        return Promise.resolve([]);
      },
    } as unknown as DiscoveryService,
    matching: {
      matchAwaiting: () => {
        calls.matching += 1;
        return Promise.resolve({
          evaluated: 0,
          reused: 0,
          shortlisted: 0,
          rejected: 0,
          notified: 0,
        });
      },
    } as unknown as JobMatchService,
    publisher: {
      publishBatch: () => {
        calls.publishing += 1;
        return Promise.resolve({
          attempted: 0,
          delivered: 0,
          retried: 0,
          deadLettered: 0,
          skippedReason: null,
        });
      },
    } as unknown as OutboxPublisher,
    readiness: probe.service,
    loadFacts: () => {
      calls.facts += 1;
      return Promise.resolve([]);
    },
  });
  return { scheduler, calls, probe };
}

describe('scheduler readiness gating', () => {
  it('does no work at all while the configuration is not usable', async () => {
    const { scheduler, calls } = buildScheduler([notReady]);
    const tick = await scheduler.tick(new Date('2026-09-25T10:00:00.000Z'));
    expect(tick).toMatchObject({ ran: false, skippedReason: 'not_ready' });
    expect(calls).toEqual({ discovery: 0, matching: 0, publishing: 0, facts: 0 });
  });

  it('reports the reason instead of failing repeatedly', async () => {
    const { scheduler, calls, probe } = buildScheduler([notReady]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await scheduler.tick(new Date('2026-09-25T10:00:00.000Z'));
    }
    const status = scheduler.status();
    expect(status.ready).toBe(false);
    expect(status.problems[0]?.code).toBe('profile_incomplete');
    expect(status.lastRanAt).toBeNull();
    expect(calls.discovery).toBe(0);
    expect(probe.calls).toBe(5);
  });

  it('reports the problem before the first tick', async () => {
    const { scheduler } = buildScheduler([notReady]);
    const readiness = await scheduler.prime(new Date('2026-09-25T10:00:00.000Z'));
    expect(readiness.ready).toBe(false);
    expect(scheduler.status()).toMatchObject({ ready: false, started: false, lastRanAt: null });
  });

  it('starts working as soon as the problem is fixed, without a restart', async () => {
    const { scheduler, calls } = buildScheduler([notReady, ready]);
    const blocked = await scheduler.tick(new Date('2026-09-25T10:00:00.000Z'));
    expect(blocked.ran).toBe(false);
    const allowed = await scheduler.tick(new Date('2026-09-25T10:15:00.000Z'));
    expect(allowed).toMatchObject({ ran: true, skippedReason: null });
    expect(calls).toEqual({ discovery: 1, matching: 1, publishing: 1, facts: 1 });
    expect(scheduler.status()).toMatchObject({ ready: true });
    expect(scheduler.status().lastRanAt).not.toBeNull();
  });

  it('stops cleanly and reports that it is no longer started', () => {
    const { scheduler } = buildScheduler([ready]);
    scheduler.start();
    expect(scheduler.status().started).toBe(true);
    scheduler.stop();
    expect(scheduler.status().started).toBe(false);
  });
});
