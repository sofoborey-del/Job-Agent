import type { FactSensitivity, FactUsePolicy, KnowledgeFact } from '@job-agent/domain';
import { knowledgeFactSchema } from '@job-agent/knowledge-base';
import type { EncryptedEnvelope } from '@job-agent/security';
import type { FieldCipher } from '@job-agent/security';
import { v7 as uuidv7 } from 'uuid';

export * from './documents.js';
export * from './cv-processing.js';
export * from './cv-history-draft.js';
export * from './leaving-reason-links.js';
export * from './defender-scanner.js';

export type StoredKnowledgeFact = Omit<KnowledgeFact<unknown>, 'value'> & {
  userId: string;
  encryptedValue: EncryptedEnvelope;
};

export interface ProfileRepository {
  createUser(userId: string, timezone: string): Promise<void>;
  nextVersion(userId: string, key: string): Promise<number>;
  saveFact(fact: StoredKnowledgeFact): Promise<void>;
  listActiveFacts(userId: string): Promise<StoredKnowledgeFact[]>;
  deleteFactVersions(userId: string, key: string): Promise<void>;
}

export type AddUserFactInput = {
  userId: string;
  key: string;
  value: unknown;
  confirmed: boolean;
  sensitivity: FactSensitivity;
  usePolicy: FactUsePolicy;
  allowedPurposes: Array<'matching' | 'application' | 'reporting'>;
};

function associatedData(
  fact: Pick<StoredKnowledgeFact, 'userId' | 'id' | 'key' | 'version'>,
): string {
  return [fact.userId, fact.id, fact.key, String(fact.version)].join('|');
}

export class ProfileService {
  constructor(
    private readonly repository: ProfileRepository,
    private readonly cipher: FieldCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createUser(timezone = 'Europe/London'): Promise<{ userId: string }> {
    if (timezone.trim() === '') throw new Error('Timezone is required');
    const userId = uuidv7();
    await this.repository.createUser(userId, timezone);
    return { userId };
  }

  async addConfirmedUserFact(input: AddUserFactInput): Promise<KnowledgeFact<unknown>> {
    if (!input.confirmed) throw new Error('A fact must be explicitly confirmed by the user');
    const version = await this.repository.nextVersion(input.userId, input.key);
    const confirmedAt = this.now().toISOString();
    const fact: KnowledgeFact<unknown> = {
      id: uuidv7(),
      key: input.key,
      value: input.value,
      status: 'verified',
      source: 'user',
      sourceRef: `local-onboarding:${confirmedAt}`,
      verifiedAt: confirmedAt,
      sensitivity: input.sensitivity,
      usePolicy: input.usePolicy,
      allowedPurposes: input.allowedPurposes,
      version,
    };
    knowledgeFactSchema.parse(fact);
    const stored: StoredKnowledgeFact = {
      id: fact.id,
      userId: input.userId,
      key: fact.key,
      status: fact.status,
      source: fact.source,
      ...(fact.sourceRef === undefined ? {} : { sourceRef: fact.sourceRef }),
      ...(fact.verifiedAt === undefined ? {} : { verifiedAt: fact.verifiedAt }),
      ...(fact.expiresAt === undefined ? {} : { expiresAt: fact.expiresAt }),
      sensitivity: fact.sensitivity,
      usePolicy: fact.usePolicy,
      allowedPurposes: fact.allowedPurposes,
      version: fact.version,
      encryptedValue: this.cipher.encryptJson(
        input.value,
        associatedData({
          userId: input.userId,
          id: fact.id,
          key: fact.key,
          version: fact.version,
        }),
      ),
    };
    await this.repository.saveFact(stored);
    return fact;
  }

  async listFacts(userId: string): Promise<KnowledgeFact<unknown>[]> {
    const storedFacts = await this.repository.listActiveFacts(userId);
    return storedFacts.map((stored) => ({
      id: stored.id,
      key: stored.key,
      value: this.cipher.decryptJson(stored.encryptedValue, associatedData(stored)),
      status: stored.status,
      source: stored.source,
      ...(stored.sourceRef === undefined ? {} : { sourceRef: stored.sourceRef }),
      ...(stored.verifiedAt === undefined ? {} : { verifiedAt: stored.verifiedAt }),
      ...(stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt }),
      sensitivity: stored.sensitivity,
      usePolicy: stored.usePolicy,
      allowedPurposes: stored.allowedPurposes,
      version: stored.version,
    }));
  }

  /** Removes all stored versions of one fact. Callers must restrict which keys may be deleted. */
  async deleteUserFact(userId: string, key: string): Promise<void> {
    await this.repository.deleteFactVersions(userId, key);
  }
}

export class InMemoryProfileRepository implements ProfileRepository {
  private readonly users = new Set<string>();
  private readonly facts: StoredKnowledgeFact[] = [];

  createUser(userId: string): Promise<void> {
    this.users.add(userId);
    return Promise.resolve();
  }

  nextVersion(userId: string, key: string): Promise<number> {
    const version =
      Math.max(
        0,
        ...this.facts
          .filter((fact) => fact.userId === userId && fact.key === key)
          .map((fact) => fact.version),
      ) + 1;
    return Promise.resolve(version);
  }

  saveFact(fact: StoredKnowledgeFact): Promise<void> {
    if (!this.users.has(fact.userId)) throw new Error('Unknown user');
    const previousIndex = this.facts.findIndex(
      (candidate) =>
        candidate.userId === fact.userId &&
        candidate.key === fact.key &&
        candidate.version === fact.version,
    );
    if (previousIndex >= 0) throw new Error('Duplicate fact version');
    this.facts.push(fact);
    return Promise.resolve();
  }

  listActiveFacts(userId: string): Promise<StoredKnowledgeFact[]> {
    const latestByKey = new Map<string, StoredKnowledgeFact>();
    for (const fact of this.facts.filter((candidate) => candidate.userId === userId)) {
      const current = latestByKey.get(fact.key);
      if (current === undefined || current.version < fact.version) latestByKey.set(fact.key, fact);
    }
    return Promise.resolve([...latestByKey.values()]);
  }

  deleteFactVersions(userId: string, key: string): Promise<void> {
    for (let index = this.facts.length - 1; index >= 0; index -= 1) {
      if (this.facts[index]?.userId === userId && this.facts[index]?.key === key) {
        this.facts.splice(index, 1);
      }
    }
    return Promise.resolve();
  }
}
