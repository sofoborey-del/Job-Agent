import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { PGliteDatabase } from './sql.js';

const migrationDirectory = fileURLToPath(new URL('../../../migrations', import.meta.url));

/**
 * Creates a throwaway in-memory database with every migration applied. Used by tests so that
 * repository behaviour is verified against the real schema rather than a mock.
 */
export async function createMigratedTestDatabase(): Promise<{
  db: PGliteDatabase;
  raw: PGlite;
  close: () => Promise<void>;
}> {
  const raw = await PGlite.create();
  const filenames = (await readdir(migrationDirectory))
    .filter((filename) => /^\d+_[a-z0-9_]+\.sql$/.test(filename))
    .sort();
  for (const filename of filenames) {
    await raw.exec(await readFile(path.join(migrationDirectory, filename), 'utf8'));
  }
  return {
    db: new PGliteDatabase(raw),
    raw,
    close: async () => {
      await raw.close();
    },
  };
}
