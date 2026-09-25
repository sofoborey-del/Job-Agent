import type { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';

export type SqlRow = Record<string, unknown>;

export type SqlResult<T extends SqlRow> = {
  rows: T[];
  rowCount: number;
};

export interface SqlExecutor {
  query<T extends SqlRow>(text: string, params?: readonly unknown[]): Promise<SqlResult<T>>;
}

export interface SqlDatabase extends SqlExecutor {
  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

class PgExecutor implements SqlExecutor {
  constructor(private readonly client: Pool | PoolClient) {}

  async query<T extends SqlRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlResult<T>> {
    const result = await this.client.query<T>(text, [...params]);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  }
}

/** PostgreSQL deployment. */
export class PostgresDatabase implements SqlDatabase {
  private readonly executor: PgExecutor;

  constructor(private readonly pool: Pool) {
    this.executor = new PgExecutor(pool);
  }

  query<T extends SqlRow>(text: string, params: readonly unknown[] = []): Promise<SqlResult<T>> {
    return this.executor.query<T>(text, params);
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PgExecutor(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

type PGliteQueryable = {
  query: (query: string, params?: unknown[]) => Promise<{ rows: SqlRow[]; affectedRows?: number }>;
};

class PGliteExecutor implements SqlExecutor {
  constructor(private readonly db: PGliteQueryable) {}

  async query<T extends SqlRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlResult<T>> {
    const result = await this.db.query(text, [...params]);
    return { rows: result.rows as T[], rowCount: result.affectedRows ?? result.rows.length };
  }
}

/** Embedded PostgreSQL-compatible deployment, which is the default for the local MVP. */
export class PGliteDatabase implements SqlDatabase {
  private readonly executor: PGliteExecutor;

  constructor(private readonly db: PGlite) {
    this.executor = new PGliteExecutor(db);
  }

  query<T extends SqlRow>(text: string, params: readonly unknown[] = []): Promise<SqlResult<T>> {
    return this.executor.query<T>(text, params);
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    // The callback's value is captured rather than returned, so a unit of work that legitimately
    // resolves to undefined is not mistaken for a failure. A throw still rolls the transaction back.
    const box: { value?: T } = {};
    await this.db.transaction(async (transaction) => {
      box.value = await work(new PGliteExecutor(transaction));
    });
    return box.value as T;
  }
}

export function firstRow<T extends SqlRow>(result: SqlResult<T>): T | null {
  return result.rows[0] ?? null;
}

export function requireRow<T extends SqlRow>(result: SqlResult<T>, message: string): T {
  const row = result.rows[0];
  if (row === undefined) throw new Error(message);
  return row;
}

export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

export function iso(value: unknown, fallback: string): string {
  return isoOrNull(value) ?? fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = asNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

export function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asNullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
