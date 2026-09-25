import {
  detailFetcherForDomain,
  fetchJobFeed,
  normaliseDiscoveredJob,
  scheduleIntervalOrMinimum,
  type NormalisedJob,
} from '@job-agent/discovery';
import type { CriteriaReadOptions } from '@job-agent/discovery';
import type { MalwareScanner } from '@job-agent/document-safety';
import { newCorrelationId, silentLogger, type StructuredLogger } from '@job-agent/observability';
import { discoveryPermitted, PolicyRateLimiter, type SitePolicy } from '@job-agent/policy';

import { extractJobRequirements } from './requirements.js';
import type { TrackingStores } from './ports.js';
import {
  emptyDiscoveryRunCounts,
  type DiscoveryRunCounts,
  type DiscoveryTrigger,
  type SourceRecord,
} from './types.js';

const MAX_CONSECUTIVE_FAILURES = 4;
const CIRCUIT_OPEN_MINUTES = 60;

export type SitePolicyLookup = (domain: string) => Promise<SitePolicy | null>;

export type DiscoveryServiceOptions = {
  stores: TrackingStores;
  userId: string;
  sitePolicyFor: SitePolicyLookup;
  fetcher?: typeof fetch;
  /**
   * Supplied to read the criteria document an advert links. Without it no attachment is fetched and
   * discovery behaves exactly as it did before.
   */
  scanner?: MalwareScanner;
  logger?: StructuredLogger;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type DiscoveryRunSummary = {
  runId: string | null;
  sourceKey: string;
  status: 'succeeded' | 'failed' | 'skipped' | 'already_ran';
  skipReason: string | null;
  errorCode: string | null;
  counts: DiscoveryRunCounts;
  newlyTrackedJobIds: string[];
};

function slotKey(trigger: DiscoveryTrigger, source: SourceRecord, now: Date): string {
  const intervalMs =
    trigger === 'scheduled'
      ? scheduleIntervalOrMinimum(source.scheduleIntervalSeconds) * 1000
      : 300_000;
  const slot = Math.floor(now.getTime() / intervalMs) * intervalMs;
  return `${trigger}:${new Date(slot).toISOString()}`;
}

async function defaultSleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Scheduled, read-only discovery. It fetches only URLs a reviewed site policy allows, never
 * visits an application form or an authenticated page, and is safe to run repeatedly.
 */
export class DiscoveryService {
  private readonly logger: StructuredLogger;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: DiscoveryServiceOptions) {
    this.logger = options.logger ?? silentLogger;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async runSource(input: {
    sourceKey: string;
    trigger: DiscoveryTrigger;
    correlationId?: string;
    now?: Date;
  }): Promise<DiscoveryRunSummary> {
    const now = input.now ?? new Date();
    const correlationId = input.correlationId ?? newCorrelationId();
    const { stores } = this.options;
    const counts: DiscoveryRunCounts = { ...emptyDiscoveryRunCounts };
    const empty = (status: DiscoveryRunSummary['status'], skipReason: string | null) => ({
      runId: null,
      sourceKey: input.sourceKey,
      status,
      skipReason,
      errorCode: null,
      counts,
      newlyTrackedJobIds: [],
    });

    const runtime = await stores.runtime.get();
    if (runtime.paused) return empty('skipped', 'agent_paused');

    const source = await stores.sources.getByKey(input.sourceKey);
    if (source === null) return empty('skipped', 'source_not_found');
    if (!source.enabled) return empty('skipped', 'source_disabled');
    if (source.circuitOpenUntil !== null && new Date(source.circuitOpenUntil) > now) {
      return empty('skipped', 'circuit_open');
    }

    const policy = await this.options.sitePolicyFor(source.sitePolicyDomain);
    if (policy === null) return empty('skipped', 'site_policy_missing');
    const action = source.adapterType === 'public_feed' ? 'feed' : 'manual_url';
    const permission = discoveryPermitted(policy, action, now);
    if (!permission.allowed) return empty('skipped', permission.reason);

    const detailFetcher = detailFetcherForDomain(source.sitePolicyDomain);
    if (detailFetcher === null) return empty('skipped', 'no_reviewed_parser');

    const configVersion = await stores.configuration.current();
    const { run, created } = await stores.discoveryRuns.begin({
      sourceId: source.id,
      trigger: input.trigger,
      idempotencyKey: slotKey(input.trigger, source, now),
      correlationId,
      configVersionId: configVersion?.id ?? null,
      now,
    });
    if (!created) {
      return {
        runId: run.id,
        sourceKey: source.sourceKey,
        status: 'already_ran',
        skipReason: 'duplicate_run',
        errorCode: null,
        counts: run.counts,
        newlyTrackedJobIds: [],
      };
    }

    const limiter = new PolicyRateLimiter(policy);
    const newlyTrackedJobIds: string[] = [];
    const seenExternalIds: string[] = [];
    let listingWasComplete = source.adapterType === 'public_feed';

    try {
      const candidates = await this.candidateUrls(source, policy, limiter);
      const urls = candidates.slice(0, source.maxItemsPerRun);
      if (candidates.length > source.maxItemsPerRun) listingWasComplete = false;

      for (const url of urls) {
        counts.fetched += 1;
        try {
          await this.sleep(limiter.delayFor(now.getTime()));
          limiter.record();
          const discovered = await detailFetcher(
            url,
            this.options.fetcher,
            this.criteriaOptions(policy, limiter, now),
          );
          const normalised: NormalisedJob = normaliseDiscoveredJob(source.sourceKey, discovered);
          seenExternalIds.push(normalised.externalId);
          const result = await stores.jobs.ingest({
            userId: this.options.userId,
            sourceId: source.id,
            sourceKey: source.sourceKey,
            externalId: normalised.externalId,
            discoveryRunId: run.id,
            correlationId,
            job: normalised,
            requirements: extractJobRequirements(
              normalised.description,
              normalised.personSpecification.text,
            ),
            now,
          });
          if (result.outcome === 'created') {
            counts.created += 1;
            newlyTrackedJobIds.push(result.jobId);
          } else if (result.outcome === 'changed') {
            counts.changed += 1;
            newlyTrackedJobIds.push(result.jobId);
          } else if (result.outcome === 'duplicate') {
            counts.duplicates += 1;
          } else {
            counts.unchanged += 1;
          }
        } catch (error) {
          counts.errors += 1;
          listingWasComplete = false;
          this.logger.log('warn', 'Discovery item failed', {
            sourceKey: source.sourceKey,
            correlationId,
            errorMessage: error instanceof Error ? error.message : 'unknown',
          });
        }
      }

      if (listingWasComplete && seenExternalIds.length > 0) {
        const closed = await stores.jobs.closeMissing({
          userId: this.options.userId,
          sourceId: source.id,
          seenExternalIds,
          correlationId,
          now,
        });
        counts.closed += closed.length;
      }
      const expired = await stores.jobs.expireOverdue({
        userId: this.options.userId,
        correlationId,
        now,
      });
      counts.closed += expired.length;

      await stores.discoveryRuns.finish({ runId: run.id, status: 'succeeded', counts, now });
      const intervalMs = scheduleIntervalOrMinimum(source.scheduleIntervalSeconds) * 1000;
      await stores.sources.recordSuccess(source.id, now, new Date(now.getTime() + intervalMs));
      await stores.audit.append(
        {
          userId: this.options.userId,
          actorType: input.trigger === 'scheduled' ? 'system' : 'user',
          actorId: null,
          action: 'discovery.run',
          resourceType: 'source',
          resourceId: source.sourceKey,
          result: 'succeeded',
          policyVersion: String(policy.version),
          correlationId,
          metadata: { ...counts, trigger: input.trigger },
        },
        now,
      );
      return {
        runId: run.id,
        sourceKey: source.sourceKey,
        status: 'succeeded',
        skipReason: null,
        errorCode: null,
        counts,
        newlyTrackedJobIds,
      };
    } catch (error) {
      const errorCode = error instanceof Error ? error.name : 'unknown_error';
      counts.errors += 1;
      await stores.discoveryRuns.finish({
        runId: run.id,
        status: 'failed',
        counts,
        errorCode,
        now,
      });
      const failures = source.consecutiveFailures + 1;
      const intervalMs = scheduleIntervalOrMinimum(source.scheduleIntervalSeconds) * 1000;
      await stores.sources.recordFailure(
        source.id,
        now,
        errorCode,
        new Date(now.getTime() + intervalMs),
        failures >= MAX_CONSECUTIVE_FAILURES
          ? new Date(now.getTime() + CIRCUIT_OPEN_MINUTES * 60_000)
          : null,
      );
      await stores.outbox.enqueue(
        {
          eventType: 'DISCOVERY_FAILED',
          channel: 'discord',
          dedupeKey: `discovery_failed:${run.id}`,
          correlationId,
          payload: {
            source: source.displayName,
            sourceKey: source.sourceKey,
            errorCode,
            circuitOpened: failures >= MAX_CONSECUTIVE_FAILURES,
          },
        },
        now,
      );
      this.logger.log('error', 'Discovery run failed', {
        sourceKey: source.sourceKey,
        correlationId,
        errorCode,
      });
      return {
        runId: run.id,
        sourceKey: source.sourceKey,
        status: 'failed',
        skipReason: null,
        errorCode,
        counts,
        newlyTrackedJobIds,
      };
    } finally {
      await stores.sources.releaseLease(source.id);
    }
  }

  /** Runs every source that the schedule says is due. Used by the background scheduler. */
  async runDue(input: {
    now?: Date;
    leaseOwner: string;
    limit?: number;
  }): Promise<DiscoveryRunSummary[]> {
    const now = input.now ?? new Date();
    const runtime = await this.options.stores.runtime.get();
    if (runtime.paused) return [];
    const due = await this.options.stores.sources.claimDue(
      now,
      input.leaseOwner,
      900,
      input.limit ?? 5,
    );
    const summaries: DiscoveryRunSummary[] = [];
    for (const source of due) {
      summaries.push(
        await this.runSource({ sourceKey: source.sourceKey, trigger: 'scheduled', now }),
      );
    }
    return summaries;
  }

  /**
   * Ingests one manually supplied public vacancy URL through exactly the same pipeline as a
   * scheduled run, so manual and scheduled discovery cannot drift apart.
   */
  async ingestManualUrl(input: {
    sourceKey: string;
    url: string;
    correlationId?: string;
    now?: Date;
  }): Promise<{
    status: 'ingested' | 'skipped';
    reason: string | null;
    jobId: string | null;
    outcome: string | null;
  }> {
    const now = input.now ?? new Date();
    const correlationId = input.correlationId ?? newCorrelationId();
    const { stores } = this.options;
    const source = await stores.sources.getByKey(input.sourceKey);
    if (source === null)
      return { status: 'skipped', reason: 'source_not_found', jobId: null, outcome: null };
    const policy = await this.options.sitePolicyFor(source.sitePolicyDomain);
    if (policy === null)
      return { status: 'skipped', reason: 'site_policy_missing', jobId: null, outcome: null };
    const permission = discoveryPermitted(policy, 'manual_url', now);
    if (!permission.allowed) {
      return { status: 'skipped', reason: permission.reason, jobId: null, outcome: null };
    }
    const detailFetcher = detailFetcherForDomain(source.sitePolicyDomain);
    if (detailFetcher === null) {
      return { status: 'skipped', reason: 'no_reviewed_parser', jobId: null, outcome: null };
    }

    const { run } = await stores.discoveryRuns.begin({
      sourceId: source.id,
      trigger: 'manual_url',
      idempotencyKey: `manual_url:${input.url}:${new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString()}`,
      correlationId,
      configVersionId: (await stores.configuration.current())?.id ?? null,
      now,
    });

    const counts: DiscoveryRunCounts = { ...emptyDiscoveryRunCounts, fetched: 1 };
    try {
      const discovered = await detailFetcher(
        input.url,
        this.options.fetcher,
        this.criteriaOptions(policy, new PolicyRateLimiter(policy), now),
      );
      const normalised = normaliseDiscoveredJob(source.sourceKey, discovered);
      const result = await stores.jobs.ingest({
        userId: this.options.userId,
        sourceId: source.id,
        sourceKey: source.sourceKey,
        externalId: normalised.externalId,
        discoveryRunId: run.id,
        correlationId,
        job: normalised,
        requirements: extractJobRequirements(
          normalised.description,
          normalised.personSpecification.text,
        ),
        now,
      });
      if (result.outcome === 'created') counts.created = 1;
      else if (result.outcome === 'changed') counts.changed = 1;
      else if (result.outcome === 'duplicate') counts.duplicates = 1;
      else counts.unchanged = 1;
      await stores.discoveryRuns.finish({ runId: run.id, status: 'succeeded', counts, now });
      return { status: 'ingested', reason: null, jobId: result.jobId, outcome: result.outcome };
    } catch (error) {
      counts.errors = 1;
      const errorCode = error instanceof Error ? error.name : 'unknown_error';
      await stores.discoveryRuns.finish({
        runId: run.id,
        status: 'failed',
        counts,
        errorCode,
        now,
      });
      throw error;
    }
  }

  /**
   * Criteria-reading options, or undefined when nothing should be fetched. Each attachment request
   * goes through the same reviewed rate limiter as a page request.
   */
  private criteriaOptions(
    policy: SitePolicy,
    limiter: PolicyRateLimiter,
    now: Date,
  ): CriteriaReadOptions | undefined {
    const scanner = this.options.scanner;
    if (scanner === undefined) return undefined;
    if (policy.attachmentRead?.allowed !== true) return undefined;
    return {
      policy,
      scanner,
      now,
      beforeRequest: async () => {
        await this.sleep(limiter.delayFor(Date.now()));
        limiter.record();
      },
    };
  }

  private async candidateUrls(
    source: SourceRecord,
    policy: SitePolicy,
    limiter: PolicyRateLimiter,
  ): Promise<string[]> {
    if (source.adapterType === 'manual_url_list') return [...source.manualUrls];
    if (source.feedUrl === null) throw new Error('The feed source has no configured feed URL');
    await this.sleep(limiter.delayFor());
    limiter.record();
    const items = await fetchJobFeed(source.feedUrl, policy, {
      ...(this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher }),
    });
    return items.map((item) => item.url);
  }
}
