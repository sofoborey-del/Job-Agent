import type { KnowledgeFact } from '@job-agent/domain';
import { newCorrelationId, silentLogger, type StructuredLogger } from '@job-agent/observability';
import type {
  DiscoveryService,
  JobMatchService,
  SchedulerReadiness,
  SchedulerReadinessService,
} from '@job-agent/tracking';

import type { OutboxPublisher } from './outbox-publisher.js';

export type SchedulerOptions = {
  discovery: DiscoveryService;
  matching: JobMatchService;
  publisher: OutboxPublisher;
  readiness: SchedulerReadinessService;
  loadFacts: () => Promise<readonly KnowledgeFact<unknown>[]>;
  logger?: StructuredLogger;
  tickIntervalMs?: number;
  leaseOwner?: string;
};

export type TickSummary = {
  correlationId: string;
  ran: boolean;
  skippedReason: string | null;
  sourcesRun: number;
  matched: number;
  notificationsDelivered: number;
};

export type SchedulerStatus = {
  started: boolean;
  ready: boolean;
  problems: SchedulerReadiness['problems'];
  enabledSources: number;
  lastCheckedAt: string | null;
  lastRanAt: string | null;
};

/**
 * The background loop: confirm the agent is safe to run, poll due sources, score anything new,
 * then deliver notifications. Every step is individually idempotent, so a crash mid-tick is safe.
 * When the configuration is not usable the loop reports why and does nothing, rather than failing
 * the same way every few minutes.
 */
export class DiscoveryScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private lastReadiness: SchedulerReadiness | null = null;
  private lastProblemSignature: string | null = null;
  private lastRanAt: string | null = null;
  private readonly logger: StructuredLogger;

  constructor(private readonly options: SchedulerOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  status(): SchedulerStatus {
    return {
      started: this.started,
      ready: this.lastReadiness?.ready ?? false,
      problems: this.lastReadiness?.problems ?? [],
      enabledSources: this.lastReadiness?.enabledSources ?? 0,
      lastCheckedAt: this.lastReadiness?.checkedAt ?? null,
      lastRanAt: this.lastRanAt,
    };
  }

  /** Runs one readiness check so the status is populated before the first tick. */
  async prime(now = new Date()): Promise<SchedulerReadiness> {
    return this.evaluateReadiness(now);
  }

  async tick(now = new Date()): Promise<TickSummary> {
    const correlationId = newCorrelationId();
    const idle: TickSummary = {
      correlationId,
      ran: false,
      skippedReason: null,
      sourcesRun: 0,
      matched: 0,
      notificationsDelivered: 0,
    };

    const readiness = await this.evaluateReadiness(now);
    if (!readiness.ready) return { ...idle, skippedReason: 'not_ready' };

    const summaries = await this.options.discovery.runDue({
      now,
      leaseOwner: this.options.leaseOwner ?? 'local-scheduler',
    });
    const facts = await this.options.loadFacts();
    const matchSummary = await this.options.matching.matchAwaiting({ facts, correlationId, now });
    const publishSummary = await this.options.publisher.publishBatch(now);
    this.lastRanAt = now.toISOString();
    const tick: TickSummary = {
      correlationId,
      ran: true,
      skippedReason: null,
      sourcesRun: summaries.length,
      matched: matchSummary.evaluated,
      notificationsDelivered: publishSummary.delivered,
    };
    this.logger.log('info', 'Scheduler tick complete', { ...tick });
    return tick;
  }

  start(): void {
    if (this.timer !== null) return;
    this.started = true;
    const interval = this.options.tickIntervalMs ?? 300_000;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.tick()
        .catch((error: unknown) => {
          this.logger.log('error', 'Scheduler tick failed', {
            errorMessage: error instanceof Error ? error.message : 'unknown',
          });
        })
        .finally(() => {
          this.running = false;
        });
    }, interval);
    this.timer.unref();
  }

  stop(): void {
    this.started = false;
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async evaluateReadiness(now: Date): Promise<SchedulerReadiness> {
    const readiness = await this.options.readiness.check(now);
    this.lastReadiness = readiness;
    const signature = readiness.problems.map((problem) => problem.code).join('|');
    if (signature !== this.lastProblemSignature) {
      this.lastProblemSignature = signature;
      if (readiness.ready) {
        this.logger.log('info', 'Scheduled discovery is ready to run', {
          enabledSources: readiness.enabledSources,
        });
      } else {
        this.logger.log('warn', 'Scheduled discovery is idle until its configuration is fixed', {
          problems: readiness.problems.map((problem) => problem.code),
        });
      }
    }
    return readiness;
  }
}
