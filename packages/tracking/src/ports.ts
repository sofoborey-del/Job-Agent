import type { SourceDefinition } from '@job-agent/discovery';

import type { LifecycleStatus, ReviewStatus } from './state.js';
import type {
  Actor,
  AuditEntry,
  ConfigurationVersionRecord,
  DiscoveryRunCounts,
  DiscoveryRunRecord,
  DiscoveryTrigger,
  IngestInput,
  IngestResult,
  JobAwaitingMatch,
  MatchExplanation,
  MatchRunRecord,
  OutboxEventInput,
  OutboxEventRecord,
  RuntimeState,
  SourceRecord,
  TrackedJobDetail,
  TrackedJobPage,
  TrackerFilter,
  TrackingRecord,
} from './types.js';

export interface SourceStore {
  upsertDefinition(definition: SourceDefinition, now: Date): Promise<SourceRecord>;
  list(): Promise<SourceRecord[]>;
  getByKey(sourceKey: string): Promise<SourceRecord | null>;
  setEnabled(sourceKey: string, enabled: boolean, reason: string | null): Promise<SourceRecord>;
  setManualUrls(sourceKey: string, urls: string[]): Promise<SourceRecord>;
  /** Atomically leases sources that are due, so two workers never poll the same source at once. */
  claimDue(
    now: Date,
    leaseOwner: string,
    leaseSeconds: number,
    limit: number,
  ): Promise<SourceRecord[]>;
  releaseLease(sourceId: string): Promise<void>;
  recordSuccess(sourceId: string, now: Date, nextRunAt: Date): Promise<void>;
  recordFailure(
    sourceId: string,
    now: Date,
    errorCode: string,
    nextRunAt: Date,
    circuitOpenUntil: Date | null,
  ): Promise<void>;
}

export interface DiscoveryRunStore {
  begin(input: {
    sourceId: string;
    trigger: DiscoveryTrigger;
    idempotencyKey: string;
    correlationId: string;
    configVersionId: string | null;
    now: Date;
  }): Promise<{ run: DiscoveryRunRecord; created: boolean }>;
  finish(input: {
    runId: string;
    status: 'succeeded' | 'failed' | 'skipped';
    counts: DiscoveryRunCounts;
    errorCode?: string | null;
    skipReason?: string | null;
    now: Date;
  }): Promise<void>;
  recent(limit: number): Promise<DiscoveryRunRecord[]>;
}

export interface JobIngestionStore {
  /** Idempotent: the same normalised job ingested twice produces one canonical job. */
  ingest(input: IngestInput): Promise<IngestResult>;
  /** Marks jobs the source stopped listing as closed. Returns the affected job ids. */
  closeMissing(input: {
    userId: string;
    sourceId: string;
    seenExternalIds: string[];
    correlationId: string;
    now: Date;
  }): Promise<string[]>;
  /** Moves jobs whose closing date has passed to expired. Returns the affected job ids. */
  expireOverdue(input: { userId: string; correlationId: string; now: Date }): Promise<string[]>;
}

export interface UserStore {
  exists(userId: string): Promise<boolean>;
}

export interface TrackingStore {
  get(userId: string, jobId: string): Promise<TrackingRecord | null>;
  list(filter: TrackerFilter): Promise<TrackedJobPage>;
  detail(userId: string, jobId: string): Promise<TrackedJobDetail | null>;
  listAwaitingMatch(userId: string, limit: number): Promise<JobAwaitingMatch[]>;
  /** One tracked job prepared for matching, whether or not it is currently flagged for re-match. */
  getForMatching(userId: string, jobId: string): Promise<JobAwaitingMatch | null>;
  changeReviewStatus(input: {
    userId: string;
    jobId: string;
    to: ReviewStatus;
    actor: Actor;
    decidedBy: 'system' | 'user';
    reason: string;
    correlationId: string;
    expectedVersion?: number;
    now: Date;
  }): Promise<TrackingRecord>;
  setLifecycleStatus(input: {
    userId: string;
    jobId: string;
    to: LifecycleStatus;
    reason: string;
    correlationId: string;
    duplicateOfJobId?: string | null;
    now: Date;
  }): Promise<TrackingRecord>;
  attachMatchRun(input: {
    userId: string;
    jobId: string;
    matchRunId: string;
    score: number;
    salaryGate: 'pass' | 'reject' | 'unknown';
    now: Date;
  }): Promise<void>;
  counts(userId: string): Promise<Record<ReviewStatus, number>>;
}

export interface MatchRunStore {
  findByIdempotencyKey(key: string): Promise<MatchRunRecord | null>;
  insert(input: {
    userId: string;
    jobId: string;
    jobVersion: number;
    idempotencyKey: string;
    matcherVersion: string;
    policyVersion: string;
    profileSnapshotHash: string;
    configVersionId: string | null;
    discoveryRunId: string | null;
    correlationId: string;
    action: MatchRunRecord['action'];
    score: number;
    evidenceCoverage: number;
    decisionConfidence: number;
    salaryGate: 'pass' | 'reject' | 'unknown';
    hardGateResult: string;
    explanation: MatchExplanation;
    requirementMatches: Array<{
      requirementId: string;
      outcome: MatchExplanation['requirements'][number]['outcome'];
      evidenceFactIds: string[];
      confidence: number;
      explanation: string;
    }>;
    now: Date;
  }): Promise<MatchRunRecord>;
  latestForJob(userId: string, jobId: string): Promise<MatchRunRecord | null>;
}

export interface ConfigurationStore {
  ensureVersion(config: unknown, createdBy: 'system' | 'user'): Promise<ConfigurationVersionRecord>;
  current(): Promise<ConfigurationVersionRecord | null>;
}

export interface OutboxStore {
  /** Returns false when an event with the same dedupe key already exists. */
  enqueue(event: OutboxEventInput, now: Date): Promise<boolean>;
  claimBatch(now: Date, limit: number): Promise<OutboxEventRecord[]>;
  markPublished(id: string, now: Date): Promise<void>;
  markFailed(input: {
    id: string;
    errorCode: string;
    retryAt: Date | null;
    deadLetter: boolean;
    now: Date;
  }): Promise<void>;
  deadLetters(limit: number): Promise<OutboxEventRecord[]>;
  pendingCount(now: Date): Promise<number>;
}

export interface InboxStore {
  /** Returns false when this producer event has already been processed. */
  claim(producer: string, eventId: string, payloadHash: string, now: Date): Promise<boolean>;
}

export interface AuditStore {
  append(entry: AuditEntry, now: Date): Promise<void>;
}

export interface RuntimeStateStore {
  get(): Promise<RuntimeState>;
  setPaused(paused: boolean, reason: string | null, now: Date): Promise<RuntimeState>;
}

export type TrackingStores = {
  users: UserStore;
  sources: SourceStore;
  discoveryRuns: DiscoveryRunStore;
  jobs: JobIngestionStore;
  tracking: TrackingStore;
  matchRuns: MatchRunStore;
  configuration: ConfigurationStore;
  outbox: OutboxStore;
  inbox: InboxStore;
  audit: AuditStore;
  runtime: RuntimeStateStore;
};
