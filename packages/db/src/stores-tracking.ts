import type { NormalisedJob } from '@job-agent/discovery';
import type { MatchRunStore, TrackingStore } from '@job-agent/tracking';
import {
  assessShortlistEntry,
  assertReviewTransition,
  type Actor,
  type JobAwaitingMatch,
  type JobRequirementRecord,
  type LifecycleStatus,
  type MatchExplanation,
  type MatchRunRecord,
  type ReviewStatus,
  type TrackedJobDetail,
  type TrackedJobPage,
  type TrackedJobSummary,
  type TrackerFilter,
  type TrackingRecord,
} from '@job-agent/tracking';
import { v7 as uuidv7 } from 'uuid';

import { setLifecycle } from './stores-discovery.js';
import {
  asBoolean,
  asNullableNumber,
  asNullableText,
  asNumber,
  asRecord,
  asStringArray,
  asText,
  firstRow,
  iso,
  isoOrNull,
  requireRow,
  type SqlDatabase,
  type SqlExecutor,
  type SqlRow,
} from './sql.js';

const lifecycleValues: readonly LifecycleStatus[] = [
  'open',
  'changed',
  'closed',
  'expired',
  'duplicate',
];
const reviewValues: readonly ReviewStatus[] = [
  'discovered',
  'rejected',
  'shortlisted',
  'reviewed',
  'archived',
];

function asLifecycle(value: unknown): LifecycleStatus {
  const text = asText(value, 'open');
  return lifecycleValues.includes(text as LifecycleStatus) ? (text as LifecycleStatus) : 'open';
}

function asReview(value: unknown): ReviewStatus {
  const text = asText(value, 'discovered');
  return reviewValues.includes(text as ReviewStatus) ? (text as ReviewStatus) : 'discovered';
}

function asSalaryGate(value: unknown): 'pass' | 'reject' | 'unknown' | null {
  const text = asNullableText(value);
  return text === 'pass' || text === 'reject' || text === 'unknown' ? text : null;
}

function mapTracking(row: SqlRow): TrackingRecord {
  return {
    id: asText(row.id),
    userId: asText(row.user_id),
    jobId: asText(row.job_id),
    lifecycleStatus: asLifecycle(row.lifecycle_status),
    reviewStatus: asReview(row.review_status),
    decidedBy: asText(row.decided_by, 'system') === 'user' ? 'user' : 'system',
    statusReason: asNullableText(row.status_reason),
    duplicateOfJobId: asNullableText(row.duplicate_of_job_id),
    lastMatchRunId: asNullableText(row.last_match_run_id),
    score: asNullableNumber(row.score),
    salaryGate: asSalaryGate(row.salary_gate),
    needsRematch: asBoolean(row.needs_rematch),
    firstSeenAt: iso(row.first_seen_at, new Date().toISOString()),
    lastSeenAt: iso(row.last_seen_at, new Date().toISOString()),
    statusChangedAt: iso(row.status_changed_at, new Date().toISOString()),
    version: asNumber(row.version, 1),
  };
}

const summaryColumns = `t.id AS tracking_id, t.user_id, t.job_id, t.lifecycle_status, t.review_status,
  t.decided_by, t.status_reason, t.duplicate_of_job_id, t.last_match_run_id, t.score, t.salary_gate,
  t.needs_rematch, t.first_seen_at, t.last_seen_at, t.status_changed_at, t.version,
  j.title, j.canonical_url, j.location_json, j.source_key, j.salary_min_minor, j.salary_max_minor,
  j.salary_basis, j.posted_at, j.closes_at, j.version AS job_version, j.description_completeness,
  c.canonical_name AS employer,
  m.explanation_json`;

/**
 * The tables every tracker read needs. The match run is joined rather than fetched separately so
 * that one query yields both the row and what the agent could establish about it.
 */
const summaryFrom = `job_tracking t
         JOIN jobs j ON j.id = t.job_id
         JOIN companies c ON c.id = j.company_id
         LEFT JOIN match_runs m ON m.id = t.last_match_run_id`;

function mapSummary(row: SqlRow): TrackedJobSummary {
  const location = asRecord(row.location_json);
  const completeness = asText(row.description_completeness) === 'snippet' ? 'snippet' : 'full';
  return {
    jobId: asText(row.job_id),
    title: asText(row.title),
    employer: asText(row.employer),
    location: asText(location.text),
    canonicalUrl: asText(row.canonical_url),
    sourceKey: asNullableText(row.source_key),
    lifecycleStatus: asLifecycle(row.lifecycle_status),
    reviewStatus: asReview(row.review_status),
    decidedBy: asText(row.decided_by, 'system') === 'user' ? 'user' : 'system',
    statusReason: asNullableText(row.status_reason),
    score: asNullableNumber(row.score),
    salaryGate: asSalaryGate(row.salary_gate),
    salaryMinMinor: asNullableNumber(row.salary_min_minor),
    salaryMaxMinor: asNullableNumber(row.salary_max_minor),
    salaryBasis: asNullableText(row.salary_basis),
    postedAt: isoOrNull(row.posted_at),
    closesAt: isoOrNull(row.closes_at),
    firstSeenAt: iso(row.first_seen_at, new Date().toISOString()),
    lastSeenAt: iso(row.last_seen_at, new Date().toISOString()),
    jobVersion: asNumber(row.job_version, 1),
    descriptionCompleteness: completeness,
    duplicateOfJobId: asNullableText(row.duplicate_of_job_id),
    assessment: assessShortlistEntry({
      explanation:
        row.explanation_json === null || row.explanation_json === undefined
          ? null
          : (asRecord(row.explanation_json) as unknown as MatchExplanation),
      descriptionCompleteness: completeness,
      lifecycleStatus: asText(row.lifecycle_status),
    }),
  };
}

async function appendTrackingEvent(
  executor: SqlExecutor,
  input: {
    trackingId: string;
    eventType: string;
    actor: Actor;
    fromReview?: ReviewStatus;
    toReview?: ReviewStatus;
    reason: string;
    correlationId: string;
    now: Date;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO job_tracking_events (
       id, job_tracking_id, sequence, event_type, actor, from_review_status, to_review_status,
       reason, correlation_id, occurred_at
     )
     SELECT $1, $2,
            COALESCE((SELECT MAX(sequence) FROM job_tracking_events WHERE job_tracking_id = $2), 0) + 1,
            $3, $4, $5, $6, $7, $8, $9`,
    [
      uuidv7(),
      input.trackingId,
      input.eventType,
      input.actor,
      input.fromReview ?? null,
      input.toReview ?? null,
      input.reason,
      input.correlationId,
      input.now,
    ],
  );
}

/**
 * Anything other than a recorded 'read' or 'unreadable' is treated as 'absent'. A row that cannot be
 * understood never becomes a claim that the criteria were seen.
 */
function mapPersonSpecification(row: SqlRow): NormalisedJob['personSpecification'] {
  const status = asNullableText(row.person_spec_status);
  const sourcesValue = row.person_spec_sources_json;
  const sources = Array.isArray(sourcesValue)
    ? sourcesValue.flatMap((entry) => {
        const record = asRecord(entry);
        const url = asNullableText(record.url);
        const sha256 = asNullableText(record.sha256);
        return url === null || sha256 === null ? [] : [{ url, sha256 }];
      })
    : [];
  if (status === 'read') {
    const text = asNullableText(row.person_spec_text);
    if (text !== null) return { status: 'read', text, reason: null, sources };
  }
  if (status === 'unreadable') {
    return {
      status: 'unreadable',
      text: null,
      reason: asNullableText(row.person_spec_reason),
      sources: [],
    };
  }
  return { status: 'absent', text: null, reason: null, sources: [] };
}

const awaitingColumns = `t.id AS tracking_id, t.review_status, t.decided_by, t.lifecycle_status,
  j.id AS job_id, j.version AS job_version, j.canonical_url, j.title, j.description, j.description_completeness,
  j.location_json, j.employment_types, j.contract_type, j.hours, j.work_pattern,
  j.external_id, j.source_key, j.content_hash, j.fingerprint, j.posted_at, j.closes_at,
  j.salary_min_minor, j.salary_max_minor, j.salary_currency, j.salary_basis,
  j.salary_confidence, j.salary_source_text, j.person_spec_status, j.person_spec_text,
  j.person_spec_reason, j.person_spec_sources_json, c.canonical_name AS employer`;

export class SqlTrackingStore implements TrackingStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(userId: string, jobId: string): Promise<TrackingRecord | null> {
    const result = await this.db.query(
      `SELECT * FROM job_tracking WHERE user_id = $1 AND job_id = $2`,
      [userId, jobId],
    );
    const row = firstRow(result);
    return row === null ? null : mapTracking(row);
  }

  async list(filter: TrackerFilter): Promise<TrackedJobPage> {
    const conditions: string[] = ['t.user_id = $1'];
    const params: unknown[] = [filter.userId];
    const add = (clause: (placeholder: string) => string, value: unknown): void => {
      params.push(value);
      conditions.push(clause(`$${String(params.length)}`));
    };

    if (filter.reviewStatuses !== undefined && filter.reviewStatuses.length > 0) {
      add((p) => `t.review_status = ANY(${p}::text[])`, filter.reviewStatuses);
    }
    if (filter.lifecycleStatuses !== undefined && filter.lifecycleStatuses.length > 0) {
      add((p) => `t.lifecycle_status = ANY(${p}::text[])`, filter.lifecycleStatuses);
    }
    if (filter.minScore !== undefined) add((p) => `t.score >= ${p}`, filter.minScore);
    if (filter.maxScore !== undefined) add((p) => `t.score <= ${p}`, filter.maxScore);
    if (filter.employer !== undefined && filter.employer !== '') {
      add((p) => `c.canonical_name ILIKE '%' || ${p} || '%'`, filter.employer);
    }
    if (filter.location !== undefined && filter.location !== '') {
      add((p) => `j.location_json->>'text' ILIKE '%' || ${p} || '%'`, filter.location);
    }
    if (filter.salaryGates !== undefined && filter.salaryGates.length > 0) {
      add((p) => `t.salary_gate = ANY(${p}::text[])`, filter.salaryGates);
    }
    if (filter.minSalaryMinor !== undefined) {
      add((p) => `COALESCE(j.salary_max_minor, j.salary_min_minor) >= ${p}`, filter.minSalaryMinor);
    }
    if (filter.maxSalaryMinor !== undefined) {
      add((p) => `COALESCE(j.salary_min_minor, j.salary_max_minor) <= ${p}`, filter.maxSalaryMinor);
    }
    if (filter.discoveredFrom !== undefined) {
      add((p) => `t.first_seen_at >= ${p}::timestamptz`, filter.discoveredFrom);
    }
    if (filter.discoveredTo !== undefined) {
      add((p) => `t.first_seen_at <= ${p}::timestamptz`, filter.discoveredTo);
    }
    if (filter.closingBefore !== undefined) {
      add(
        (p) => `j.closes_at IS NOT NULL AND j.closes_at <= ${p}::timestamptz`,
        filter.closingBefore,
      );
    }
    if (filter.sourceKeys !== undefined && filter.sourceKeys.length > 0) {
      add((p) => `j.source_key = ANY(${p}::text[])`, filter.sourceKeys);
    }
    if (filter.query !== undefined && filter.query !== '') {
      add(
        (p) => `(j.title ILIKE '%' || ${p} || '%' OR c.canonical_name ILIKE '%' || ${p} || '%')`,
        filter.query,
      );
    }

    const where = conditions.join(' AND ');
    const order =
      filter.sort === 'score_asc'
        ? 't.score ASC NULLS LAST, t.first_seen_at DESC'
        : filter.sort === 'discovered_desc'
          ? 't.first_seen_at DESC'
          : filter.sort === 'closing_soon'
            ? 'j.closes_at ASC NULLS LAST'
            : 't.score DESC NULLS LAST, t.first_seen_at DESC';
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);

    const totalResult = await this.db.query(
      `SELECT COUNT(*)::int AS total FROM ${summaryFrom}
        WHERE ${where}`,
      params,
    );
    const rows = await this.db.query(
      `SELECT ${summaryColumns} FROM ${summaryFrom}
        WHERE ${where}
        ORDER BY ${order}
        LIMIT ${String(limit)} OFFSET ${String(offset)}`,
      params,
    );
    return {
      total: asNumber(firstRow(totalResult)?.total, rows.rows.length),
      jobs: rows.rows.map(mapSummary),
    };
  }

  async detail(userId: string, jobId: string): Promise<TrackedJobDetail | null> {
    const result = await this.db.query(
      `SELECT ${summaryColumns} FROM ${summaryFrom}
        WHERE t.user_id = $1 AND t.job_id = $2`,
      [userId, jobId],
    );
    const row = firstRow(result);
    if (row === null) return null;
    const history = await this.db.query(
      `SELECT sequence, event_type, actor, reason, occurred_at
         FROM job_tracking_events WHERE job_tracking_id = $1
        ORDER BY sequence DESC LIMIT 50`,
      [asText(row.tracking_id)],
    );
    const matchRunId = asNullableText(row.last_match_run_id);
    const matchRun =
      matchRunId === null ? null : await new SqlMatchRunStore(this.db).findById(matchRunId);
    return {
      ...mapSummary(row),
      matchRun,
      history: history.rows.map((event) => ({
        sequence: asNumber(event.sequence),
        eventType: asText(event.event_type),
        actor: asText(event.actor, 'system') as Actor,
        reason: asText(event.reason),
        occurredAt: iso(event.occurred_at, new Date().toISOString()),
      })),
    };
  }

  async listAwaitingMatch(
    userId: string,
    limit: number,
    matcherVersion?: string,
  ): Promise<JobAwaitingMatch[]> {
    // A job is due either because an ingest flagged it, or because the matcher that last scored it
    // is not the matcher running now. Only the first was checked before, so changing the matcher
    // re-scored nothing at all and old decisions stayed on the tracker indefinitely.
    const result = await this.db.query(
      `SELECT ${awaitingColumns}
         FROM job_tracking t
         JOIN jobs j ON j.id = t.job_id
         JOIN companies c ON c.id = j.company_id
         LEFT JOIN match_runs m ON m.id = t.last_match_run_id
        WHERE t.user_id = $1
          AND (
            t.needs_rematch
            OR ($3::text IS NOT NULL AND (m.matcher_version IS NULL OR m.matcher_version <> $3))
          )
          AND t.lifecycle_status NOT IN ('closed', 'expired', 'duplicate')
        ORDER BY t.last_seen_at DESC
        LIMIT $2`,
      [userId, limit, matcherVersion ?? null],
    );
    const entries: JobAwaitingMatch[] = [];
    for (const row of result.rows) entries.push(await this.awaitingFromRow(row));
    return entries;
  }

  async getForMatching(userId: string, jobId: string): Promise<JobAwaitingMatch | null> {
    const result = await this.db.query(
      `SELECT ${awaitingColumns}
         FROM job_tracking t
         JOIN jobs j ON j.id = t.job_id
         JOIN companies c ON c.id = j.company_id
        WHERE t.user_id = $1 AND t.job_id = $2`,
      [userId, jobId],
    );
    const row = firstRow(result);
    return row === null ? null : this.awaitingFromRow(row);
  }

  private async awaitingFromRow(row: SqlRow): Promise<JobAwaitingMatch> {
    const jobId = asText(row.job_id);
    const requirements = await this.db.query(
      `SELECT id, job_id, category, requirement_text, mandatory, evidence_excerpt,
              extraction_confidence
         FROM job_requirements WHERE job_id = $1 ORDER BY created_at, id`,
      [jobId],
    );
    const currency = asNullableText(row.salary_currency);
    const basis = asNullableText(row.salary_basis);
    const minimumMinor = asNullableNumber(row.salary_min_minor);
    const maximumMinor = asNullableNumber(row.salary_max_minor);
    const salary: NormalisedJob['salary'] =
      currency !== 'GBP' || (minimumMinor === null && maximumMinor === null)
        ? null
        : {
            ...(minimumMinor === null ? {} : { minimumMinor }),
            ...(maximumMinor === null ? {} : { maximumMinor }),
            currency: 'GBP',
            basis: basis === 'annual_base' || basis === 'hourly' ? basis : 'unknown',
            confidence: asNumber(row.salary_confidence, 0.5),
            sourceText: asText(row.salary_source_text),
          };
    return {
      jobId,
      jobVersion: asNumber(row.job_version, 1),
      trackingId: asText(row.tracking_id),
      reviewStatus: asReview(row.review_status),
      decidedBy: asText(row.decided_by, 'system') === 'user' ? 'user' : 'system',
      lifecycleStatus: asLifecycle(row.lifecycle_status),
      job: {
        sourceKey: asText(row.source_key),
        externalId: asText(row.external_id),
        canonicalUrl: asText(row.canonical_url),
        fingerprint: asText(row.fingerprint),
        contentHash: asText(row.content_hash),
        title: asText(row.title),
        employer: asText(row.employer),
        location: asText(asRecord(row.location_json).text),
        description: asText(row.description),
        descriptionCompleteness:
          asText(row.description_completeness) === 'snippet' ? 'snippet' : 'full',
        salary,
        employmentTypes: asStringArray(row.employment_types),
        contractType: asNullableText(row.contract_type),
        hours: asNullableText(row.hours),
        workPattern: asNullableText(row.work_pattern),
        publishedAt: isoOrNull(row.posted_at),
        closesAt: isoOrNull(row.closes_at),
        personSpecification: mapPersonSpecification(row),
      },
      requirements: requirements.rows.map((requirement): JobRequirementRecord => ({
        id: asText(requirement.id),
        jobId: asText(requirement.job_id),
        category: asText(requirement.category),
        text: asText(requirement.requirement_text),
        mandatory: asBoolean(requirement.mandatory),
        evidenceExcerpt: asText(requirement.evidence_excerpt),
        extractionConfidence: asNumber(requirement.extraction_confidence, 0),
      })),
    };
  }

  async changeReviewStatus(input: {
    userId: string;
    jobId: string;
    to: ReviewStatus;
    actor: Actor;
    decidedBy: 'system' | 'user';
    reason: string;
    correlationId: string;
    expectedVersion?: number;
    now: Date;
  }): Promise<TrackingRecord> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query(
        `SELECT * FROM job_tracking WHERE user_id = $1 AND job_id = $2`,
        [input.userId, input.jobId],
      );
      const existing = mapTracking(requireRow(current, 'This job is not being tracked'));
      if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
        throw new Error('The tracker entry changed while you were looking at it');
      }
      if (existing.decidedBy === 'user' && input.decidedBy === 'system') {
        return existing;
      }
      assertReviewTransition(existing.reviewStatus, input.to);
      if (existing.reviewStatus === input.to && existing.decidedBy === input.decidedBy) {
        return existing;
      }
      const updated = await tx.query(
        `UPDATE job_tracking
            SET review_status = $3, decided_by = $4, status_reason = $5,
                status_changed_at = $6, updated_at = $6, version = version + 1
          WHERE user_id = $1 AND job_id = $2
        RETURNING *`,
        [input.userId, input.jobId, input.to, input.decidedBy, input.reason, input.now],
      );
      const record = mapTracking(requireRow(updated, 'The tracker entry could not be updated'));
      await appendTrackingEvent(tx, {
        trackingId: record.id,
        eventType: `review.${input.to}`,
        actor: input.actor,
        fromReview: existing.reviewStatus,
        toReview: input.to,
        reason: input.reason,
        correlationId: input.correlationId,
        now: input.now,
      });
      return record;
    });
  }

  async setLifecycleStatus(input: {
    userId: string;
    jobId: string;
    to: LifecycleStatus;
    reason: string;
    correlationId: string;
    duplicateOfJobId?: string | null;
    now: Date;
  }): Promise<TrackingRecord> {
    return this.db.transaction(async (tx) => {
      await setLifecycle(tx, {
        userId: input.userId,
        jobId: input.jobId,
        lifecycleStatus: input.to,
        reason: input.reason,
        correlationId: input.correlationId,
        duplicateOfJobId: input.duplicateOfJobId ?? null,
        now: input.now,
      });
      const result = await tx.query(
        `SELECT * FROM job_tracking WHERE user_id = $1 AND job_id = $2`,
        [input.userId, input.jobId],
      );
      return mapTracking(requireRow(result, 'This job is not being tracked'));
    });
  }

  async attachMatchRun(input: {
    userId: string;
    jobId: string;
    matchRunId: string;
    score: number;
    salaryGate: 'pass' | 'reject' | 'unknown';
    now: Date;
  }): Promise<void> {
    await this.db.query(
      `UPDATE job_tracking
          SET last_match_run_id = $3, score = $4, salary_gate = $5, needs_rematch = false,
              updated_at = $6, version = version + 1
        WHERE user_id = $1 AND job_id = $2`,
      [input.userId, input.jobId, input.matchRunId, input.score, input.salaryGate, input.now],
    );
  }

  async counts(userId: string): Promise<Record<ReviewStatus, number>> {
    const result = await this.db.query(
      `SELECT review_status, COUNT(*)::int AS total FROM job_tracking
        WHERE user_id = $1 GROUP BY review_status`,
      [userId],
    );
    const counts: Record<ReviewStatus, number> = {
      discovered: 0,
      rejected: 0,
      shortlisted: 0,
      reviewed: 0,
      archived: 0,
    };
    for (const row of result.rows) counts[asReview(row.review_status)] = asNumber(row.total);
    return counts;
  }
}

function mapMatchRun(row: SqlRow): MatchRunRecord {
  const explanation = asRecord(row.explanation_json) as unknown as MatchExplanation;
  const action = asText(row.action, 'reject');
  const gate = asSalaryGate(row.salary_gate) ?? 'unknown';
  return {
    id: asText(row.id),
    userId: asText(row.user_id),
    jobId: asText(row.job_id),
    jobVersion: asNumber(row.job_version, 1),
    idempotencyKey: asText(row.idempotency_key),
    matcherVersion: asText(row.matcher_version),
    policyVersion: asText(row.policy_version),
    profileSnapshotHash: asText(row.profile_snapshot_hash),
    configVersionId: asNullableText(row.config_version_id),
    action:
      action === 'shortlist' || action === 'prefill_with_approval' || action === 'auto_apply'
        ? action
        : 'reject',
    score: asNumber(row.score),
    evidenceCoverage: asNumber(row.evidence_coverage),
    decisionConfidence: asNumber(row.decision_confidence),
    salaryGate: gate,
    hardGateResult: asText(row.hard_gate_result),
    explanation,
    createdAt: iso(row.created_at, new Date().toISOString()),
  };
}

const matchRunColumns = `id, user_id, job_id, job_version, idempotency_key, matcher_version,
  policy_version, profile_snapshot_hash, config_version_id, action, score, evidence_coverage,
  decision_confidence, salary_gate, hard_gate_result, explanation_json, created_at`;

export class SqlMatchRunStore implements MatchRunStore {
  constructor(private readonly db: SqlDatabase) {}

  async findById(id: string): Promise<MatchRunRecord | null> {
    const result = await this.db.query(`SELECT ${matchRunColumns} FROM match_runs WHERE id = $1`, [
      id,
    ]);
    const row = firstRow(result);
    return row === null ? null : mapMatchRun(row);
  }

  async findByIdempotencyKey(key: string): Promise<MatchRunRecord | null> {
    const result = await this.db.query(
      `SELECT ${matchRunColumns} FROM match_runs WHERE idempotency_key = $1`,
      [key],
    );
    const row = firstRow(result);
    return row === null ? null : mapMatchRun(row);
  }

  async latestForJob(userId: string, jobId: string): Promise<MatchRunRecord | null> {
    const result = await this.db.query(
      `SELECT ${matchRunColumns} FROM match_runs
        WHERE user_id = $1 AND job_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [userId, jobId],
    );
    const row = firstRow(result);
    return row === null ? null : mapMatchRun(row);
  }

  async insert(input: Parameters<MatchRunStore['insert']>[0]): Promise<MatchRunRecord> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO match_runs (
           id, user_id, job_id, job_version, profile_snapshot_version, profile_snapshot_hash,
           matcher_version, policy_version, config_version_id, discovery_run_id, correlation_id,
           hard_gate_result, score, evidence_coverage, decision_confidence, action, salary_gate,
           explanation_json, idempotency_key, created_at
         ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING ${matchRunColumns}`,
        [
          uuidv7(),
          input.userId,
          input.jobId,
          input.jobVersion,
          input.profileSnapshotHash,
          input.matcherVersion,
          input.policyVersion,
          input.configVersionId,
          input.discoveryRunId,
          input.correlationId,
          input.hardGateResult,
          input.score,
          input.evidenceCoverage,
          input.decisionConfidence,
          input.action,
          input.salaryGate,
          JSON.stringify(input.explanation),
          input.idempotencyKey,
          input.now,
        ],
      );
      const row = firstRow(inserted);
      if (row === null) {
        const existing = await tx.query(
          `SELECT ${matchRunColumns} FROM match_runs WHERE idempotency_key = $1`,
          [input.idempotencyKey],
        );
        return mapMatchRun(requireRow(existing, 'The match decision could not be stored'));
      }
      const matchRun = mapMatchRun(row);
      for (const requirement of input.requirementMatches) {
        await tx.query(
          `INSERT INTO requirement_matches (
             id, match_run_id, requirement_id, outcome, evidence_fact_ids, confidence, explanation
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (match_run_id, requirement_id) DO NOTHING`,
          [
            uuidv7(),
            matchRun.id,
            requirement.requirementId,
            requirement.outcome,
            requirement.evidenceFactIds,
            requirement.confidence,
            requirement.explanation,
          ],
        );
      }
      return matchRun;
    });
  }
}
