import { randomBytes } from 'node:crypto';

import { ProfileService } from '@job-agent/profile';
import { FieldCipher, StaticEncryptionKeyProvider } from '@job-agent/security';
import { expect, it } from 'vitest';

import { PGliteProfileRepository } from './pglite.js';
import { createMigratedTestDatabase } from './testing.js';

it('removes every encrypted version of a deleted answer from the active database', async () => {
  const database = await createMigratedTestDatabase();
  try {
    const cipher = new FieldCipher(
      new StaticEncryptionKeyProvider('test', new Map([['test', randomBytes(32)]])),
    );
    const service = new ProfileService(new PGliteProfileRepository(database.raw), cipher);
    const { userId } = await service.createUser();
    const key = 'application.answer_vault.disability_status';
    for (const value of ['First answer', 'Updated answer']) {
      await service.addConfirmedUserFact({
        userId,
        key,
        value,
        confirmed: true,
        sensitivity: 'high_risk',
        usePolicy: 'never_auto_fill',
        allowedPurposes: ['application'],
      });
    }
    await service.deleteUserFact(userId, key);
    expect((await service.listFacts(userId)).find((fact) => fact.key === key)).toBeUndefined();
    const facts = await database.db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM knowledge_facts WHERE user_id = $1 AND key = $2',
      [userId, key],
    );
    const versions = await database.db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM knowledge_fact_versions WHERE user_id = $1 AND key = $2',
      [userId, key],
    );
    expect(facts.rows[0]?.count).toBe(0);
    expect(versions.rows[0]?.count).toBe(0);
  } finally {
    await database.close();
  }
});
