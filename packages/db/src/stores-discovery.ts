import type { SourceDefinition } from '@job-agent/discovery';
import { scheduleIntervalOrMinimum } from '@job-agent/discovery';
import type { DiscoveryRunStore, JobIngestionStore, SourceStore } from '@job-agent/tracking';
import type {
  DiscoveryRunCounts,
  DiscoveryRunRecord,
  DiscoveryTrigger,
  IngestInput,
  IngestResult,
  SourceRecord,
} from '@job-agent/tracking';
import { v7 as uuidv7 } from 'uuid';

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

const sourceColumns = `id, source_key, display_name, adapter_type, site_policy_domain, feed_url,
  config_json, enabled, schedule_interval_seconds, max_items_per_run, next_run_at,
  last_success_at, last_error_code, consecutive_failures, circuit_open_until, paused_reason,
  reviewed_by, reviewed_at`;

function mapSource(row: SqlRow): SourceRecord {
  const config = asRecord(row.config_json);
  const adapterType = asText(row.adapter_type, 'manual_url_list');
  return {
    id: asText(row.id),
    sourceKey: asText(row.source_key),
    displayName: asText(row.display_name),
    adapterType: adapterType === 'public_feed' ? 'public_feed' : 'manual_url_list',
    sitePolicyDomain: asText(row.site_policy_domain),
    feedUrl: asNullableText(row.feed_url),
    manualUrls: asStringArray(config.manualUrls),
    enabled: asBoolean(row.enabled),
    scheduleIntervalSeconds: scheduleIntervalOrMinimum(
      asNullableNumber(row.schedule_interval_seconds),
    ),
    maxItemsPerRun: asNumber(row.max_items_per_run, 25),
    nextRunAt: isoOrNull(row.next_run_at),
    lastSuccessAt: isoOrNull(row.last_success_at),
    lastErrorCode: asNullableText(row.last_error_code),
    consecutiveFailures: asNumber(row.consecutive_failures, 0),
    circuitOpenUntil: isoOrNull(row.circuit_open_until),
    pausedReason: asNullableText(row.paused_reason),
    reviewedBy: asNullableText(row.reviewed_by),
    reviewedAt: isoOrNull(row.reviewed_at),
    notes: asNullableText(config.notes),
  };
}

export class SqlSourceStore implements SourceStore {
  constructor(private readonly db: SqlDatabase) {}

  async upsertDefinition(definition: SourceDefinition, now: Date): Promise<SourceRecord> {
    const config = {
      manualUrls: definition.manualUrls,
      notes: definition.notes ?? null,
    };
    const result = await this.db.query(
      `INSERT INTO sources (
         id, adapter_type, display_name, config_ref, enabled, source_key, site_policy_domain,
         config_json, feed_url, schedule_interval_seconds, max_items_per_run, next_run_at,
         reviewed_by, reviewed_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $4, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
       ON CONFLICT (source_key) DO UPDATE SET
         adapter_type = EXCLUDED.adapter_type,
         display_name = EXCLUDED.display_name,
         site_policy_domain = EXCLUDED.site_policy_domain,
         config_json = EXCLUDED.config_json,
         feed_url = EXCLUDED.feed_url,
         schedule_interval_seconds = EXCLUDED.schedule_interval_seconds,
         max_items_per_run = EXCLUDED.max_items_per_run,
         enabled = EXCLUDED.enabled,
         reviewed_by = EXCLUDED.reviewed_by,
         reviewed_at = EXCLUDED.reviewed_at,
         updated_at = EXCLUDED.updated_at
       RETURNING ${sourceColumns}`,
      [
        uuidv7(),
        definition.adapterType,
        definition.displayName,
        definition.key,
        definition.enabled,
        definition.sitePolicyDomain,
        JSON.stringify(config),
        definition.feedUrl ?? null,
        scheduleIntervalOrMinimum(definition.scheduleIntervalSeconds),
        definition.maxItemsPerRun,
        definition.enabled ? now : null,
        definition.reviewedBy,
        definition.reviewedAt,
        now,
      ],
    );
    return mapSource(requireRow(result, 'Source could not be saved'));
  }

  async list(): Promise<SourceRecord[]> {
    const result = await this.db.query(`SELECT ${sourceColumns} FROM sources ORDER BY source_key`);
    return result.rows.map(mapSource);
  }

  async getByKey(sourceKey: string): Promise<SourceRecord | null> {
    const result = await this.db.query(
      `SELECT ${sourceColumns} FROM sources WHERE source_key = $1`,
      [sourceKey],
    );
    const row = firstRow(result);
    return row === null ? null : mapSource(row);
  }

  async setEnabled(
    sourceKey: string,
    enabled: boolean,
    reason: string | null,
  ): Promise<SourceRecord> {
    const result = await this.db.query(
      `UPDATE sources
          SET enabled = $2,
              paused_reason = $3,
              next_run_at = CASE WHEN $2 THEN now() ELSE NULL END,
              circuit_open_until = CASE WHEN $2 THEN NULL ELSE circuit_open_until END,
              consecutive_failures = CASE WHEN $2 THEN 0 ELSE consecutive_failures END,
              updated_at = now()
        WHERE source_key = $1
      RETURNING ${sourceColumns}`,
      [sourceKey, enabled, reason],
    );
    return mapSource(requireRow(result, 'Source not found'));
  }

  async setManualUrls(sourceKey: string, urls: string[]): Promise<SourceRecord> {
    const result = await this.db.query(
      `UPDATE sources
          SET config_json = jsonb_set(config_json, '{manualUrls}', $2::jsonb, true),
              updated_at = now()
        WHERE source_key = $1
      RETURNING ${sourceColumns}`,
      [sourceKey, JSON.stringify(urls)],
    );
    return mapSource(requireRow(result, 'Source not found'));
  }

  async claimDue(
    now: Date,
    leaseOwner: string,
    leaseSeconds: number,
    limit: number,
  ): Promise<SourceRecord[]> {
    const leaseExpiry = new Date(now.getTime() + leaseSeconds * 1000);
    const result = await this.db.query(
      `UPDATE sources SET lease_owner = $2, lease_expires_at = $3, updated_at = $1
        WHERE id IN (
          SELECT id FROM sources
           WHERE enabled
             AND (next_run_at IS NULL OR next_run_at <= $1)
             AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
             AND (circuit_open_until IS NULL OR circuit_open_until <= $1)
           ORDER BY next_run_at NULLS FIRST
           LIMIT $4
        )
      RETURNING ${sourceColumns}`,
      [now, leaseOwner, leaseExpiry, limit],
    );
    return result.rows.map(mapSource);
  }

  async releaseLease(sourceId: string): Promise<void> {
    await this.db.query(
      `UPDATE sources SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`,
      [sourceId],
    );
  }

  async recordSuccess(sourceId: string, now: Date, nextRunAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE sources
          SET last_success_at = $2, last_error_code = NULL, consecutive_failures = 0,
              circuit_open_until = NULL, next_run_at = $3, updated_at = $2
        WHERE id = $1`,
      [sourceId, now, nextRunAt],
    );
  }

  async recordFailure(
    sourceId: string,
    now: Date,
    errorCode: string,
    nextRunAt: Date,
    circuitOpenUntil: Date | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE sources
          SET last_error_code = $3,
              consecutive_failures = consecutive_failures + 1,
              circuit_open_until = $5,
              paused_reason = CASE WHEN $5 IS NULL THEN paused_reason ELSE 'repeated_failures' END,
              next_run_at = $4,
              updated_at = $2
        WHERE id = $1`,
      [sourceId, now, errorCode, nextRunAt, circuitOpenUntil],
    );
  }
}

const runColumns = `r.id, r.source_id, s.source_key, r.trigger, r.idempotency_key, r.correlation_id,
  r.status, r.skip_reason, r.error_code, r.fetched_count, r.new_count, r.changed_count,
  r.unchanged_count, r.duplicate_count, r.closed_count, r.error_count, r.started_at, r.finished_at`;

function mapRun(row: SqlRow): DiscoveryRunRecord {
  const trigger = asText(row.trigger, 'scheduled');
  const status = asText(row.status, 'running');
  return {
    id: asText(row.id),
    sourceId: asText(row.source_id),
    sourceKey: asText(row.source_key),
    trigger: (['scheduled', 'manual', 'manual_url'] as const).includes(trigger as DiscoveryTrigger)
      ? (trigger as DiscoveryTrigger)
      : 'scheduled',
    idempotencyKey: asText(row.idempotency_key),
    correlationId: asText(row.correlation_id),
    status:
      status === 'succeeded' || status === 'failed' || status === 'skipped' ? status : 'running',
    skipReason: asNullableText(row.skip_reason),
    errorCode: asNullableText(row.error_code),
    counts: {
      fetched: asNumber(row.fetched_count),
      created: asNumber(row.new_count),
      changed: asNumber(row.changed_count),
      unchanged: asNumber(row.unchanged_count),
      duplicates: asNumber(row.duplicate_count),
      closed: asNumber(row.closed_count),
      errors: asNumber(row.error_count),
    },
    startedAt: iso(row.started_at, new Date().toISOString()),
    finishedAt: isoOrNull(row.finished_at),
  };
}

export class SqlDiscoveryRunStore implements DiscoveryRunStore {
  constructor(private readonly db: SqlDatabase) {}

  async begin(input: {
    sourceId: string;
    trigger: DiscoveryTrigger;
    idempotencyKey: string;
    correlationId: string;
    configVersionId: string | null;
    now: Date;
  }): Promise<{ run: DiscoveryRunRecord; created: boolean }> {
    const inserted = await this.db.query(
      `INSERT INTO discovery_runs (
         id, source_id, trigger, idempotency_key, correlation_id, config_version_id, status, started_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'running', $7)
       ON CONFLICT (source_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        uuidv7(),
        input.sourceId,
        input.trigger,
        input.idempotencyKey,
        input.correlationId,
        input.configVersionId,
        input.now,
      ],
    );
    const existing = await this.db.query(
      `SELECT ${runColumns} FROM discovery_runs r
         JOIN sources s ON s.id = r.source_id
        WHERE r.source_id = $1 AND r.idempotency_key = $2`,
      [input.sourceId, input.idempotencyKey],
    );
    return {
      run: mapRun(requireRow(existing, 'Discovery run could not be started')),
      created: inserted.rows.length === 1,
    };
  }

  async finish(input: {
    runId: string;
    status: 'succeeded' | 'failed' | 'skipped';
    counts: DiscoveryRunCounts;
    errorCode?: string | null;
    skipReason?: string | null;
    now: Date;
  }): Promise<void> {
    await this.db.query(
      `UPDATE discovery_runs
          SET status = $2, finished_at = $3, error_code = $4, skip_reason = $5,
              fetched_count = $6, new_count = $7, changed_count = $8, unchanged_count = $9,
              duplicate_count = $10, closed_count = $11, error_count = $12
        WHERE id = $1`,
      [
        input.runId,
        input.status,
        input.now,
        input.errorCode ?? null,
        input.skipReason ?? null,
        input.counts.fetched,
        input.counts.created,
        input.counts.changed,
        input.counts.unchanged,
        input.counts.duplicates,
        input.counts.closed,
        input.counts.errors,
      ],
    );
  }

  async recent(limit: number): Promise<DiscoveryRunRecord[]> {
    const result = await this.db.query(
      `SELECT ${runColumns} FROM discovery_runs r
         JOIN sources s ON s.id = r.source_id
        ORDER BY r.started_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapRun);
  }
}

async function ensureCompany(executor: SqlExecutor, employer: string): Promise<string> {
  const existing = await executor.query(
    `SELECT id FROM companies WHERE lower(canonical_name) = lower($1)`,
    [employer],
  );
  const row = firstRow(existing);
  if (row !== null) return asText(row.id);
  const inserted = await executor.query(
    `INSERT INTO companies (id, canonical_name) VALUES ($1, $2)
     ON CONFLICT (lower(canonical_name)) DO UPDATE SET canonical_name = companies.canonical_name
     RETURNING id`,
    [uuidv7(), employer],
  );
  return asText(requireRow(inserted, 'Employer could not be saved').id);
}

async function ensureTracking(
  executor: SqlExecutor,
  input: {
    userId: string;
    jobId: string;
    lifecycleStatus: 'open' | 'changed' | 'duplicate';
    reason: string;
    correlationId: string;
    needsRematch: boolean;
    duplicateOfJobId: string | null;
    now: Date;
  },
): Promise<void> {
  const inserted = await executor.query(
    `INSERT INTO job_tracking (
       id, user_id, job_id, lifecycle_status, review_status, decided_by, status_reason,
       duplicate_of_job_id, needs_rematch, first_seen_at, last_seen_at, status_changed_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'discovered', 'system', $5, $6, $7, $8, $8, $8, $8)
     ON CONFLICT (user_id, job_id) DO NOTHING
     RETURNING id`,
    [
      uuidv7(),
      input.userId,
      input.jobId,
      input.lifecycleStatus,
      input.reason,
      input.duplicateOfJobId,
      input.needsRematch,
      input.now,
    ],
  );
  const trackingRow =
    firstRow(inserted) ??
    firstRow(
      await executor.query(
        `UPDATE job_tracking
            SET lifecycle_status = $3,
                status_reason = $4,
                duplicate_of_job_id = $5,
                needs_rematch = needs_rematch OR $6,
                last_seen_at = $7,
                status_changed_at = CASE WHEN lifecycle_status <> $3 THEN $7 ELSE status_changed_at END,
                updated_at = $7,
                version = version + 1
          WHERE user_id = $1 AND job_id = $2
        RETURNING id`,
        [
          input.userId,
          input.jobId,
          input.lifecycleStatus,
          input.reason,
          input.duplicateOfJobId,
          input.needsRematch,
          input.now,
        ],
      ),
    );
  if (trackingRow === null) return;
  await executor.query(
    `INSERT INTO job_tracking_events (
       id, job_tracking_id, sequence, event_type, actor, to_lifecycle_status, reason,
       correlation_id, occurred_at
     )
     SELECT $1, $2,
            COALESCE((SELECT MAX(sequence) FROM job_tracking_events WHERE job_tracking_id = $2), 0) + 1,
            $3, 'system', $4, $5, $6, $7`,
    [
      uuidv7(),
      asText(trackingRow.id),
      `job.${input.lifecycleStatus}`,
      input.lifecycleStatus,
      input.reason,
      input.correlationId,
      input.now,
    ],
  );
}

export class SqlJobIngestionStore implements JobIngestionStore {
  constructor(private readonly db: SqlDatabase) {}

  async ingest(input: IngestInput): Promise<IngestResult> {
    return this.db.transaction(async (tx) => {
      const { job } = input;
      const previous = await tx.query(
        `SELECT content_hash FROM source_jobs WHERE source_id = $1 AND external_id = $2`,
        [input.sourceId, input.externalId],
      );
      const previousContentHash = asNullableText(firstRow(previous)?.content_hash);

      const sourceJob = await tx.query(
        `INSERT INTO source_jobs (
           id, source_id, external_id, content_hash, source_key, canonical_url,
           processing_status, last_discovery_run_id, first_seen_at, last_seen_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'normalised', $7, $8, $8)
         ON CONFLICT (source_id, external_id) DO UPDATE SET
           content_hash = EXCLUDED.content_hash,
           canonical_url = EXCLUDED.canonical_url,
           processing_status = 'normalised',
           processing_error_code = NULL,
           last_discovery_run_id = EXCLUDED.last_discovery_run_id,
           last_seen_at = EXCLUDED.last_seen_at,
           closed_at = NULL
         RETURNING id`,
        [
          uuidv7(),
          input.sourceId,
          input.externalId,
          job.contentHash,
          input.sourceKey,
          job.canonicalUrl,
          input.discoveryRunId,
          input.now,
        ],
      );
      const sourceJobId = asText(requireRow(sourceJob, 'Source job could not be saved').id);

      const byUrl = await tx.query(
        `SELECT id, version, content_hash FROM jobs WHERE canonical_url = $1`,
        [job.canonicalUrl],
      );
      const existingByUrl = firstRow(byUrl);

      if (existingByUrl === null) {
        const byFingerprint = await tx.query(`SELECT id FROM jobs WHERE fingerprint = $1`, [
          job.fingerprint,
        ]);
        const duplicate = firstRow(byFingerprint);
        if (duplicate !== null) {
          const duplicateJobId = asText(duplicate.id);
          await tx.query(
            `INSERT INTO job_aliases (source_job_id, job_id) VALUES ($1, $2)
             ON CONFLICT (source_job_id) DO UPDATE SET job_id = EXCLUDED.job_id`,
            [sourceJobId, duplicateJobId],
          );
          await recordSnapshot(tx, sourceJobId, input.discoveryRunId, job.contentHash, job);
          await tx.query(`UPDATE jobs SET last_seen_at = $2 WHERE id = $1`, [
            duplicateJobId,
            input.now,
          ]);
          await ensureTracking(tx, {
            userId: input.userId,
            jobId: duplicateJobId,
            lifecycleStatus: 'open',
            reason: 'duplicate_source_record',
            correlationId: input.correlationId,
            needsRematch: false,
            duplicateOfJobId: null,
            now: input.now,
          });
          const versionRow = await tx.query(`SELECT version FROM jobs WHERE id = $1`, [
            duplicateJobId,
          ]);
          return {
            outcome: 'duplicate',
            jobId: duplicateJobId,
            jobVersion: asNumber(firstRow(versionRow)?.version, 1),
            duplicateOfJobId: duplicateJobId,
          };
        }

        const companyId = await ensureCompany(tx, job.employer);
        const created = await tx.query(
          `INSERT INTO jobs (
             id, company_id, canonical_url, title, description, location_json, employment_type,
             employment_types, contract_type, hours, work_pattern, external_id,
             salary_min_minor, salary_max_minor, salary_currency, salary_basis, salary_confidence,
             salary_source_text, posted_at, closes_at, content_hash, fingerprint, source_key,
             person_spec_status, person_spec_text, person_spec_reason, person_spec_sources_json,
             version, status, first_seen_at, last_seen_at, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
             $19, $20, $21, $22, $23, $26, $27, $28, $29, 1, $24, $25, $25, $25, $25
           )
           RETURNING id, version`,
          [
            uuidv7(),
            companyId,
            job.canonicalUrl,
            job.title,
            job.description,
            JSON.stringify({ text: job.location }),
            job.employmentTypes[0] ?? null,
            job.employmentTypes,
            job.contractType,
            job.hours,
            job.workPattern,
            job.externalId,
            job.salary?.minimumMinor ?? null,
            job.salary?.maximumMinor ?? null,
            job.salary === null ? null : job.salary.currency,
            job.salary === null ? null : job.salary.basis,
            job.salary === null ? null : job.salary.confidence,
            job.salary?.sourceText ?? null,
            job.publishedAt,
            job.closesAt,
            job.contentHash,
            job.fingerprint,
            input.sourceKey,
            job.closesAt !== null && new Date(job.closesAt) <= input.now ? 'closed' : 'open',
            input.now,
            job.personSpecification.status,
            job.personSpecification.text,
            job.personSpecification.reason,
            JSON.stringify(job.personSpecification.sources),
          ],
        );
        const jobRow = requireRow(created, 'Job could not be saved');
        const jobId = asText(jobRow.id);
        await tx.query(
          `INSERT INTO job_aliases (source_job_id, job_id) VALUES ($1, $2)
           ON CONFLICT (source_job_id) DO UPDATE SET job_id = EXCLUDED.job_id`,
          [sourceJobId, jobId],
        );
        await insertRequirements(tx, jobId, input.requirements);
        await recordSnapshot(tx, sourceJobId, input.discoveryRunId, job.contentHash, job);
        await ensureTracking(tx, {
          userId: input.userId,
          jobId,
          lifecycleStatus: 'open',
          reason: 'discovered',
          correlationId: input.correlationId,
          needsRematch: true,
          duplicateOfJobId: null,
          now: input.now,
        });
        return { outcome: 'created', jobId, jobVersion: 1, duplicateOfJobId: null };
      }

      const jobId = asText(existingByUrl.id);
      await tx.query(
        `INSERT INTO job_aliases (source_job_id, job_id) VALUES ($1, $2)
         ON CONFLICT (source_job_id) DO UPDATE SET job_id = EXCLUDED.job_id`,
        [sourceJobId, jobId],
      );
      const unchanged = asText(existingByUrl.content_hash) === job.contentHash;
      if (unchanged && previousContentHash === job.contentHash) {
        await tx.query(`UPDATE jobs SET last_seen_at = $2, status = $3 WHERE id = $1`, [
          jobId,
          input.now,
          job.closesAt !== null && new Date(job.closesAt) <= input.now ? 'closed' : 'open',
        ]);
        return {
          outcome: 'unchanged',
          jobId,
          jobVersion: asNumber(existingByUrl.version, 1),
          duplicateOfJobId: null,
        };
      }

      const companyId = await ensureCompany(tx, job.employer);
      const updated = await tx.query(
        `UPDATE jobs SET
           company_id = $2, title = $3, description = $4, location_json = $5, employment_type = $6,
           employment_types = $7, contract_type = $8, hours = $9, work_pattern = $10,
           salary_min_minor = $11, salary_max_minor = $12, salary_currency = $13, salary_basis = $14,
           salary_confidence = $15, salary_source_text = $16, posted_at = $17, closes_at = $18,
           content_hash = $19, fingerprint = $20, source_key = COALESCE(source_key, $21),
           person_spec_status = $24, person_spec_text = $25, person_spec_reason = $26,
           person_spec_sources_json = $27,
           version = CASE WHEN content_hash = $19 THEN version ELSE version + 1 END,
           status = $22, last_seen_at = $23, updated_at = $23
         WHERE id = $1
         RETURNING version`,
        [
          jobId,
          companyId,
          job.title,
          job.description,
          JSON.stringify({ text: job.location }),
          job.employmentTypes[0] ?? null,
          job.employmentTypes,
          job.contractType,
          job.hours,
          job.workPattern,
          job.salary?.minimumMinor ?? null,
          job.salary?.maximumMinor ?? null,
          job.salary === null ? null : job.salary.currency,
          job.salary === null ? null : job.salary.basis,
          job.salary === null ? null : job.salary.confidence,
          job.salary?.sourceText ?? null,
          job.publishedAt,
          job.closesAt,
          job.contentHash,
          job.fingerprint,
          input.sourceKey,
          job.closesAt !== null && new Date(job.closesAt) <= input.now ? 'closed' : 'open',
          input.now,
          job.personSpecification.status,
          job.personSpecification.text,
          job.personSpecification.reason,
          JSON.stringify(job.personSpecification.sources),
        ],
      );
      await insertRequirements(tx, jobId, input.requirements);
      const recorded = await recordSnapshot(
        tx,
        sourceJobId,
        input.discoveryRunId,
        job.contentHash,
        job,
      );
      const version = asNumber(requireRow(updated, 'Job could not be updated').version, 1);
      if (unchanged) {
        return { outcome: 'unchanged', jobId, jobVersion: version, duplicateOfJobId: null };
      }
      await ensureTracking(tx, {
        userId: input.userId,
        jobId,
        lifecycleStatus: 'changed',
        reason: recorded ? 'advert_changed' : 'advert_reappeared',
        correlationId: input.correlationId,
        needsRematch: true,
        duplicateOfJobId: null,
        now: input.now,
      });
      return { outcome: 'changed', jobId, jobVersion: version, duplicateOfJobId: null };
    });
  }

  async closeMissing(input: {
    userId: string;
    sourceId: string;
    seenExternalIds: string[];
    correlationId: string;
    now: Date;
  }): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      const missing = await tx.query(
        `UPDATE source_jobs SET closed_at = $3, processing_status = 'skipped'
          WHERE source_id = $1
            AND closed_at IS NULL
            AND NOT (external_id = ANY($2::text[]))
        RETURNING id`,
        [input.sourceId, input.seenExternalIds, input.now],
      );
      const jobIds: string[] = [];
      for (const row of missing.rows) {
        const alias = await tx.query(`SELECT job_id FROM job_aliases WHERE source_job_id = $1`, [
          asText(row.id),
        ]);
        const jobId = asNullableText(firstRow(alias)?.job_id);
        if (jobId === null) continue;
        await tx.query(`UPDATE jobs SET status = 'closed', updated_at = $2 WHERE id = $1`, [
          jobId,
          input.now,
        ]);
        await setLifecycle(tx, {
          userId: input.userId,
          jobId,
          lifecycleStatus: 'closed',
          reason: 'removed_from_source_listing',
          correlationId: input.correlationId,
          now: input.now,
        });
        jobIds.push(jobId);
      }
      return jobIds;
    });
  }

  async expireOverdue(input: {
    userId: string;
    correlationId: string;
    now: Date;
  }): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      const overdue = await tx.query(
        `SELECT j.id FROM jobs j
           JOIN job_tracking t ON t.job_id = j.id AND t.user_id = $1
          WHERE j.closes_at IS NOT NULL AND j.closes_at <= $2
            AND t.lifecycle_status NOT IN ('expired', 'closed')`,
        [input.userId, input.now],
      );
      const jobIds: string[] = [];
      for (const row of overdue.rows) {
        const jobId = asText(row.id);
        await tx.query(`UPDATE jobs SET status = 'closed', updated_at = $2 WHERE id = $1`, [
          jobId,
          input.now,
        ]);
        await setLifecycle(tx, {
          userId: input.userId,
          jobId,
          lifecycleStatus: 'expired',
          reason: 'closing_date_passed',
          correlationId: input.correlationId,
          now: input.now,
        });
        jobIds.push(jobId);
      }
      return jobIds;
    });
  }
}

async function recordSnapshot(
  executor: SqlExecutor,
  sourceJobId: string,
  discoveryRunId: string,
  contentHash: string,
  normalised: unknown,
): Promise<boolean> {
  const result = await executor.query(
    `INSERT INTO source_job_snapshots (id, source_job_id, discovery_run_id, content_hash, normalised_json)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_job_id, content_hash) DO NOTHING
     RETURNING id`,
    [uuidv7(), sourceJobId, discoveryRunId, contentHash, JSON.stringify(normalised)],
  );
  return result.rows.length === 1;
}

async function insertRequirements(
  executor: SqlExecutor,
  jobId: string,
  requirements: IngestInput['requirements'],
): Promise<void> {
  for (const requirement of requirements) {
    await executor.query(
      `INSERT INTO job_requirements (
         id, job_id, category, requirement_text, mandatory, evidence_excerpt, extraction_confidence
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (job_id, md5(requirement_text)) DO NOTHING`,
      [
        uuidv7(),
        jobId,
        requirement.category,
        requirement.text,
        requirement.mandatory,
        requirement.evidenceExcerpt,
        requirement.extractionConfidence,
      ],
    );
  }
}

export async function setLifecycle(
  executor: SqlExecutor,
  input: {
    userId: string;
    jobId: string;
    lifecycleStatus: 'open' | 'changed' | 'closed' | 'expired' | 'duplicate';
    reason: string;
    correlationId: string;
    duplicateOfJobId?: string | null;
    now: Date;
  },
): Promise<SqlRow | null> {
  const updated = await executor.query(
    `UPDATE job_tracking
        SET lifecycle_status = $3,
            status_reason = $4,
            duplicate_of_job_id = COALESCE($5, duplicate_of_job_id),
            status_changed_at = CASE WHEN lifecycle_status <> $3 THEN $6 ELSE status_changed_at END,
            updated_at = $6,
            version = version + 1
      WHERE user_id = $1 AND job_id = $2
    RETURNING id, lifecycle_status`,
    [
      input.userId,
      input.jobId,
      input.lifecycleStatus,
      input.reason,
      input.duplicateOfJobId ?? null,
      input.now,
    ],
  );
  const row = firstRow(updated);
  if (row === null) return null;
  await executor.query(
    `INSERT INTO job_tracking_events (
       id, job_tracking_id, sequence, event_type, actor, to_lifecycle_status, reason,
       correlation_id, occurred_at
     )
     SELECT $1, $2,
            COALESCE((SELECT MAX(sequence) FROM job_tracking_events WHERE job_tracking_id = $2), 0) + 1,
            $3, 'system', $4, $5, $6, $7`,
    [
      uuidv7(),
      asText(row.id),
      `job.${input.lifecycleStatus}`,
      input.lifecycleStatus,
      input.reason,
      input.correlationId,
      input.now,
    ],
  );
  return row;
}
