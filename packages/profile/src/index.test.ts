import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { FieldCipher, StaticEncryptionKeyProvider } from '@job-agent/security';

import { InMemoryProfileRepository, ProfileService } from './index.js';

function createService(): ProfileService {
  const cipher = new FieldCipher(
    new StaticEncryptionKeyProvider('test-v1', new Map([['test-v1', randomBytes(32)]])),
  );
  return new ProfileService(
    new InMemoryProfileRepository(),
    cipher,
    () => new Date('2026-09-24T09:00:00.000Z'),
  );
}

describe('profile service', () => {
  it('creates a user and returns confirmed facts after encrypted storage', async () => {
    const service = createService();
    const { userId } = await service.createUser();
    const added = await service.addConfirmedUserFact({
      userId,
      key: 'preferences.minimum_salary_gbp',
      value: 25_000,
      confirmed: true,
      sensitivity: 'normal',
      usePolicy: 'auto_fill',
      allowedPurposes: ['matching', 'application'],
    });
    expect(added.status).toBe('verified');
    expect(await service.listFacts(userId)).toEqual([added]);
  });

  it('increments versions and exposes only the newest value', async () => {
    const service = createService();
    const { userId } = await service.createUser();
    for (const value of [25_000, 27_000]) {
      await service.addConfirmedUserFact({
        userId,
        key: 'preferences.minimum_salary_gbp',
        value,
        confirmed: true,
        sensitivity: 'normal',
        usePolicy: 'auto_fill',
        allowedPurposes: ['matching'],
      });
    }
    expect(await service.listFacts(userId)).toMatchObject([{ value: 27_000, version: 2 }]);
  });
});
