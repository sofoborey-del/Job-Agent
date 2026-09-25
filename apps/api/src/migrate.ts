import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';

async function migrationFiles(): Promise<Array<{ filename: string; sql: string }>> {
  const migrationDirectory = path.resolve(process.cwd(), 'migrations');
  const filenames = (await readdir(migrationDirectory))
    .filter((filename) => /^\d+_[a-z0-9_]+\.sql$/.test(filename))
    .sort();
  return Promise.all(
    filenames.map(async (filename) => ({
      filename,
      sql: await readFile(path.join(migrationDirectory, filename), 'utf8'),
    })),
  );
}

const databaseMode = process.env.DB_MODE ?? 'embedded';
const migrations = await migrationFiles();

if (databaseMode === 'embedded') {
  const database = await PGlite.create(process.env.PGLITE_DATA_DIR ?? './local-data/pglite');
  try {
    await database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    for (const migration of migrations) {
      const exists = await database.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1) AS exists',
        [migration.filename],
      );
      if (exists.rows[0]?.exists === true) continue;
      await database.transaction(async (transaction) => {
        await transaction.exec(migration.sql);
        await transaction.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [
          migration.filename,
        ]);
      });
    }
  } finally {
    await database.close();
  }
} else if (databaseMode === 'postgres') {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required in postgres mode');
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const migration of migrations) {
      const exists = await pool.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1) AS exists',
        [migration.filename],
      );
      if (exists.rows[0]?.exists === true) continue;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [
          migration.filename,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
} else {
  throw new Error('DB_MODE must be embedded or postgres');
}
