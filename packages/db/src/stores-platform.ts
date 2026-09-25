import { createHash } from 'node:crypto';

import type {
  AuditEntry,
  AuditStore,
  UserStore,
  ConfigurationStore,
  ConfigurationVersionRecord,
  InboxStore,
  OutboxEventInput,
  OutboxEventRecord,
  OutboxStore,
  RuntimeState,
  RuntimeStateStore,
} from '@job-agent/tracking';
import { v7 as uuidv7 } from 'uuid';

import {
  asNullableText,
  asNumber,
  asRecord,
  asText,
  firstRow,
  iso,
  isoOrNull,
  requireRow,
  type SqlDatabase,
  type SqlRow,
} from './sql.js';

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

export class SqlConfigurationStore implements ConfigurationStore {
  constructor(private readonly db: SqlDatabase) {}

  async ensureVersion(
    config: unknown,
    createdBy: 'system' | 'user',
  ): Promise<ConfigurationVersionRecord> {
    const serialised = stableStringify(config);
    const configHash = createHash('sha256').update(serialised).digest('hex');
    const existing = await this.db.query(
      `SELECT id, version, config_hash FROM configuration_versions WHERE config_hash = $1`,
      [configHash],
    );
    const found = firstRow(existing);
    if (found !== null) {
      return {
        id: asText(found.id),
        version: asNumber(found.version, 1),
        configHash: asText(found.config_hash),
      };
    }
    const inserted = await this.db.query(
      `INSERT INTO configuration_versions (id, version, config_hash, config_json, created_by)
       SELECT $1, COALESCE((SELECT MAX(version) FROM configuration_versions), 0) + 1, $2, $3::jsonb, $4
       ON CONFLICT (config_hash) DO NOTHING
       RETURNING id, version, config_hash`,
      [uuidv7(), configHash, serialised, createdBy],
    );
    const row = firstRow(inserted);
    if (row !== null) {
      return {
        id: asText(row.id),
        version: asNumber(row.version, 1),
        configHash: asText(row.config_hash),
      };
    }
    const retry = await this.db.query(
      `SELECT id, version, config_hash FROM configuration_versions WHERE config_hash = $1`,
      [configHash],
    );
    const retried = requireRow(retry, 'Configuration version could not be recorded');
    return {
      id: asText(retried.id),
      version: asNumber(retried.version, 1),
      configHash: asText(retried.config_hash),
    };
  }

  async current(): Promise<ConfigurationVersionRecord | null> {
    const result = await this.db.query(
      `SELECT id, version, config_hash FROM configuration_versions ORDER BY version DESC LIMIT 1`,
    );
    const row = firstRow(result);
    return row === null
      ? null
      : {
          id: asText(row.id),
          version: asNumber(row.version, 1),
          configHash: asText(row.config_hash),
        };
  }
}

function mapOutbox(row: SqlRow): OutboxEventRecord {
  return {
    id: asText(row.id),
    eventType: asText(row.event_type),
    channel: asText(row.channel, 'discord'),
    dedupeKey: asNullableText(row.dedupe_key),
    correlationId: asNullableText(row.correlation_id),
    payload: asRecord(row.payload_json),
    attempts: asNumber(row.attempts),
    maxAttempts: asNumber(row.max_attempts, 6),
    availableAt: iso(row.available_at, new Date().toISOString()),
    lastErrorCode: asNullableText(row.last_error_code),
    deadLetteredAt: isoOrNull(row.dead_lettered_at),
  };
}

const outboxColumns = `id, event_type, channel, dedupe_key, correlation_id, payload_json, attempts,
  max_attempts, available_at, last_error_code, dead_lettered_at`;

export class SqlOutboxStore implements OutboxStore {
  constructor(private readonly db: SqlDatabase) {}

  async enqueue(event: OutboxEventInput, now: Date): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO outbox_events (
         id, event_type, channel, dedupe_key, correlation_id, payload_json, available_at,
         max_attempts, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [
        uuidv7(),
        event.eventType,
        event.channel,
        event.dedupeKey,
        event.correlationId,
        JSON.stringify(event.payload),
        event.availableAt ?? now,
        event.maxAttempts ?? 6,
        now,
      ],
    );
    return result.rows.length === 1;
  }

  async claimBatch(now: Date, limit: number): Promise<OutboxEventRecord[]> {
    const result = await this.db.query(
      `UPDATE outbox_events SET attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM outbox_events
           WHERE published_at IS NULL AND dead_lettered_at IS NULL AND available_at <= $1
           ORDER BY available_at
           LIMIT $2
        )
      RETURNING ${outboxColumns}`,
      [now, limit],
    );
    return result.rows.map(mapOutbox);
  }

  async markPublished(id: string, now: Date): Promise<void> {
    await this.db.query(
      `UPDATE outbox_events SET published_at = $2, last_error_code = NULL WHERE id = $1`,
      [id, now],
    );
  }

  async markFailed(input: {
    id: string;
    errorCode: string;
    retryAt: Date | null;
    deadLetter: boolean;
    now: Date;
  }): Promise<void> {
    await this.db.query(
      `UPDATE outbox_events
          SET last_error_code = $2,
              available_at = COALESCE($3, available_at),
              dead_lettered_at = CASE WHEN $4 THEN $5 ELSE dead_lettered_at END
        WHERE id = $1`,
      [input.id, input.errorCode, input.retryAt, input.deadLetter, input.now],
    );
  }

  async deadLetters(limit: number): Promise<OutboxEventRecord[]> {
    const result = await this.db.query(
      `SELECT ${outboxColumns} FROM outbox_events
        WHERE dead_lettered_at IS NOT NULL ORDER BY dead_lettered_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapOutbox);
  }

  async pendingCount(now: Date): Promise<number> {
    const result = await this.db.query(
      `SELECT COUNT(*)::int AS total FROM outbox_events
        WHERE published_at IS NULL AND dead_lettered_at IS NULL AND available_at <= $1`,
      [now],
    );
    return asNumber(firstRow(result)?.total, 0);
  }
}

export class SqlInboxStore implements InboxStore {
  constructor(private readonly db: SqlDatabase) {}

  async claim(producer: string, eventId: string, payloadHash: string, now: Date): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO inbox_events (producer, event_id, payload_hash, processed_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (producer, event_id) DO NOTHING
       RETURNING event_id`,
      [producer, eventId, payloadHash, now],
    );
    return result.rows.length === 1;
  }
}

export class SqlAuditStore implements AuditStore {
  constructor(private readonly db: SqlDatabase) {}

  async append(entry: AuditEntry, now: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_log (
         id, user_id, actor_type, actor_id, action, resource_type, resource_id, result,
         policy_version, correlation_id, metadata_json, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
      [
        uuidv7(),
        entry.userId,
        entry.actorType,
        entry.actorId,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        entry.result,
        entry.policyVersion,
        entry.correlationId,
        JSON.stringify(entry.metadata),
        now,
      ],
    );
  }
}

export class SqlUserStore implements UserStore {
  constructor(private readonly db: SqlDatabase) {}

  async exists(userId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 AS present FROM users WHERE id = $1 AND status <> 'deleted'`,
      [userId],
    );
    return firstRow(result) !== null;
  }
}

export class SqlRuntimeStateStore implements RuntimeStateStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(): Promise<RuntimeState> {
    const result = await this.db.query(
      `SELECT paused, paused_reason, paused_at, updated_at FROM agent_runtime_state WHERE id = true`,
    );
    const row = firstRow(result);
    if (row === null) {
      return {
        paused: false,
        pausedReason: null,
        pausedAt: null,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      paused: row.paused === true,
      pausedReason: asNullableText(row.paused_reason),
      pausedAt: isoOrNull(row.paused_at),
      updatedAt: iso(row.updated_at, new Date().toISOString()),
    };
  }

  async setPaused(paused: boolean, reason: string | null, now: Date): Promise<RuntimeState> {
    await this.db.query(
      `INSERT INTO agent_runtime_state (id, paused, paused_reason, paused_at, updated_at)
       VALUES (true, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         paused = EXCLUDED.paused,
         paused_reason = EXCLUDED.paused_reason,
         paused_at = EXCLUDED.paused_at,
         updated_at = EXCLUDED.updated_at`,
      [paused, reason, paused ? now : null, now],
    );
    return this.get();
  }
}
