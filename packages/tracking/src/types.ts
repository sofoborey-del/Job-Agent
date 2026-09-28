import type { MatchAction, RequirementOutcome } from '@job-agent/domain';
import type { NormalisedJob, SourceAdapterType } from '@job-agent/discovery';

import type { LifecycleStatus, ReviewStatus } from './state.js';

export type Actor = 'user' | 'system' | 'worker';

export type SourceRecord = {
  id: string;
  sourceKey: string;
  displayName: string;
  adapterType: SourceAdapterType;
  sitePolicyDomain: string;
  feedUrl: string | null;
  manualUrls: string[];
  enabled: boolean;
  scheduleIntervalSeconds: number;
  maxItemsPerRun: number;
  nextRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  circuitOpenUntil: string | null;
  pausedReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  notes: string | null;
};

export type DiscoveryTrigger = 'scheduled' | 'manual' | 'manual_url';

export type DiscoveryRunCounts = {
  fetched: number;
  created: number;
  changed: number;
  unchanged: number;
  duplicates: number;
  closed: number;
  errors: number;
};

export const emptyDiscoveryRunCounts: DiscoveryRunCounts = {
  fetched: 0,
  created: 0,
  changed: 0,
  unchanged: 0,
  duplicates: 0,
  closed: 0,
  errors: 0,
};

export type DiscoveryRunRecord = {
  id: string;
  sourceId: string;
  sourceKey: string;
  trigger: DiscoveryTrigger;
  idempotencyKey: string;
  correlationId: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  skipReason: string | null;
  errorCode: string | null;
  counts: DiscoveryRunCounts;
  startedAt: string;
  finishedAt: string | null;
};

export type JobRecord = {
  id: string;
  companyId: string;
  canonicalUrl: string;
  fingerprint: string;
  sourceKey: string | null;
  title: string;
  employer: string;
  location: string;
  contentHash: string;
  version: number;
  status: 'open' | 'closed' | 'unknown';
  salaryMinMinor: number | null;
  salaryMaxMinor: number | null;
  salaryBasis: string | null;
  postedAt: string | null;
  closesAt: string | null;
  duplicateOfJobId: string | null;
  isCurrent: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type JobRequirementRecord = {
  id: string;
  jobId: string;
  category: string;
  text: string;
  mandatory: boolean;
  evidenceExcerpt: string;
  extractionConfidence: number;
};

export type TrackingRecord = {
  id: string;
  userId: string;
  jobId: string;
  lifecycleStatus: LifecycleStatus;
  reviewStatus: ReviewStatus;
  decidedBy: 'system' | 'user';
  statusReason: string | null;
  duplicateOfJobId: string | null;
  lastMatchRunId: string | null;
  score: number | null;
  salaryGate: 'pass' | 'reject' | 'unknown' | null;
  needsRematch: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  statusChangedAt: string;
  version: number;
};

export type MatchRunRecord = {
  id: string;
  userId: string;
  jobId: string;
  jobVersion: number;
  idempotencyKey: string;
  matcherVersion: string;
  policyVersion: string;
  profileSnapshotHash: string;
  configVersionId: string | null;
  action: MatchAction;
  score: number;
  evidenceCoverage: number;
  decisionConfidence: number;
  salaryGate: 'pass' | 'reject' | 'unknown';
  hardGateResult: string;
  explanation: MatchExplanation;
  createdAt: string;
};

export type MatchExplanation = {
  hardRejectReasons: string[];
  autoBlockers: string[];
  explanation: string[];
  signals: Record<string, number>;
  requirements: Array<{
    key: string;
    text: string;
    outcome: RequirementOutcome;
    confidence: number;
    explanation: string;
    evidenceFactIds: string[];
  }>;
};

export type ConfigurationVersionRecord = {
  id: string;
  version: number;
  configHash: string;
};

export type IngestOutcome = 'created' | 'changed' | 'unchanged' | 'duplicate';

export type IngestResult = {
  outcome: IngestOutcome;
  jobId: string;
  jobVersion: number;
  duplicateOfJobId: string | null;
};

export type ExtractedJobRequirement = {
  category: string;
  text: string;
  mandatory: boolean;
  evidenceExcerpt: string;
  extractionConfidence: number;
};

export type IngestInput = {
  userId: string;
  sourceId: string;
  sourceKey: string;
  externalId: string;
  discoveryRunId: string;
  correlationId: string;
  job: NormalisedJob;
  requirements: ExtractedJobRequirement[];
  now: Date;
};

export type TrackerSort = 'score_desc' | 'score_asc' | 'discovered_desc' | 'closing_soon';

export type TrackerFilter = {
  userId: string;
  reviewStatuses?: ReviewStatus[];
  lifecycleStatuses?: LifecycleStatus[];
  minScore?: number;
  maxScore?: number;
  employer?: string;
  location?: string;
  salaryGates?: Array<'pass' | 'reject' | 'unknown'>;
  minSalaryMinor?: number;
  maxSalaryMinor?: number;
  discoveredFrom?: string;
  discoveredTo?: string;
  closingBefore?: string;
  sourceKeys?: string[];
  query?: string;
  sort?: TrackerSort;
  limit?: number;
  offset?: number;
};

export type TrackedJobSummary = {
  jobId: string;
  title: string;
  employer: string;
  location: string;
  canonicalUrl: string;
  sourceKey: string | null;
  lifecycleStatus: LifecycleStatus;
  reviewStatus: ReviewStatus;
  decidedBy: 'system' | 'user';
  statusReason: string | null;
  score: number | null;
  salaryGate: 'pass' | 'reject' | 'unknown' | null;
  salaryMinMinor: number | null;
  salaryMaxMinor: number | null;
  salaryBasis: string | null;
  postedAt: string | null;
  closesAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  jobVersion: number;
  /**
   * Whether the stored advert text is the employer's whole advert or an aggregator excerpt. A
   * 'snippet' job can be listed and read, but no criteria were established from it, so it is never
   * scored as a match and never starts an application.
   */
  descriptionCompleteness: 'full' | 'snippet';
  /** Set when this row has been superseded by, or is a duplicate of, another tracked job. */
  duplicateOfJobId: string | null;
};

export type TrackedJobPage = {
  total: number;
  jobs: TrackedJobSummary[];
};

export type TrackedJobDetail = TrackedJobSummary & {
  matchRun: MatchRunRecord | null;
  history: Array<{
    sequence: number;
    eventType: string;
    actor: Actor;
    reason: string;
    occurredAt: string;
  }>;
};

export type JobAwaitingMatch = {
  jobId: string;
  jobVersion: number;
  trackingId: string;
  reviewStatus: ReviewStatus;
  decidedBy: 'system' | 'user';
  lifecycleStatus: LifecycleStatus;
  job: NormalisedJob;
  requirements: JobRequirementRecord[];
};

export type OutboxEventInput = {
  eventType: string;
  channel: 'discord';
  dedupeKey: string;
  correlationId: string;
  payload: Record<string, unknown>;
  availableAt?: Date;
  maxAttempts?: number;
};

export type OutboxEventRecord = {
  id: string;
  eventType: string;
  channel: string;
  dedupeKey: string | null;
  correlationId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  lastErrorCode: string | null;
  deadLetteredAt: string | null;
};

export type AuditEntry = {
  userId: string | null;
  actorType: Actor;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  result: 'allowed' | 'denied' | 'succeeded' | 'failed';
  policyVersion: string | null;
  correlationId: string;
  metadata: Record<string, unknown>;
};

export type RuntimeState = {
  paused: boolean;
  pausedReason: string | null;
  pausedAt: string | null;
  updatedAt: string;
};
