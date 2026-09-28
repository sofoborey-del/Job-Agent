import type { PGlite } from '@electric-sql/pglite';

import type {
  DocumentRepository,
  ProfileRepository,
  StoredDocument,
  StoredKnowledgeFact,
} from '@job-agent/profile';
import { decodeEnvelope, encodeEnvelope } from '@job-agent/security';

type FactRow = {
  id: string;
  user_id: string;
  key: string;
  value_ciphertext: Uint8Array;
  status: StoredKnowledgeFact['status'];
  source: StoredKnowledgeFact['source'];
  source_ref: string | null;
  sensitivity: StoredKnowledgeFact['sensitivity'];
  use_policy: StoredKnowledgeFact['usePolicy'];
  allowed_purposes: StoredKnowledgeFact['allowedPurposes'];
  version: number;
  verified_at: Date | string | null;
  expires_at: Date | string | null;
};

type DocumentRow = {
  id: string;
  user_id: string;
  type: StoredDocument['type'];
  version: number;
  object_key: string;
  sha256: string;
  mime_type: StoredDocument['mimeType'];
  approved: boolean;
  malware_scan_status: StoredDocument['malwareScanStatus'];
};

function storedDocument(row: DocumentRow): StoredDocument {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    version: row.version,
    objectKey: row.object_key,
    sha256: row.sha256,
    mimeType: row.mime_type,
    approved: row.approved,
    malwareScanStatus: row.malware_scan_status,
  };
}

function timestamp(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export class PGliteProfileRepository implements ProfileRepository, DocumentRepository {
  constructor(private readonly db: PGlite) {}

  async createUser(userId: string, timezone: string): Promise<void> {
    await this.db.query(`INSERT INTO users (id, timezone, status) VALUES ($1, $2, 'active')`, [
      userId,
      timezone,
    ]);
  }

  async nextVersion(userId: string, key: string): Promise<number> {
    const result = await this.db.query<{ last_version: number }>(
      `INSERT INTO knowledge_fact_versions (user_id, key, last_version)
       VALUES ($1, $2, 1)
       ON CONFLICT (user_id, key)
       DO UPDATE SET last_version = knowledge_fact_versions.last_version + 1
       RETURNING last_version`,
      [userId, key],
    );
    const version = result.rows[0]?.last_version;
    if (version === undefined) throw new Error('Unable to allocate a fact version');
    return version;
  }

  async saveFact(fact: StoredKnowledgeFact): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE knowledge_facts SET valid_to = now()
         WHERE user_id = $1 AND key = $2 AND valid_to IS NULL`,
        [fact.userId, fact.key],
      );
      await transaction.query(
        `INSERT INTO knowledge_facts (
           id, user_id, key, value_ciphertext, status, source, source_ref,
           sensitivity, use_policy, allowed_purposes, version, verified_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          fact.id,
          fact.userId,
          fact.key,
          encodeEnvelope(fact.encryptedValue),
          fact.status,
          fact.source,
          fact.sourceRef ?? null,
          fact.sensitivity,
          fact.usePolicy,
          fact.allowedPurposes,
          fact.version,
          fact.verifiedAt ?? null,
          fact.expiresAt ?? null,
        ],
      );
    });
  }

  async listActiveFacts(userId: string): Promise<StoredKnowledgeFact[]> {
    const result = await this.db.query<FactRow>(
      `SELECT id, user_id, key, value_ciphertext, status, source, source_ref,
              sensitivity, use_policy, allowed_purposes, version, verified_at, expires_at
       FROM knowledge_facts
       WHERE user_id = $1 AND valid_to IS NULL
       ORDER BY key`,
      [userId],
    );
    return result.rows.map((row) => {
      const verifiedAt = timestamp(row.verified_at);
      const expiresAt = timestamp(row.expires_at);
      return {
        id: row.id,
        userId: row.user_id,
        key: row.key,
        encryptedValue: decodeEnvelope(Buffer.from(row.value_ciphertext)),
        status: row.status,
        source: row.source,
        ...(row.source_ref === null ? {} : { sourceRef: row.source_ref }),
        ...(verifiedAt === undefined ? {} : { verifiedAt }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        sensitivity: row.sensitivity,
        usePolicy: row.use_policy,
        allowedPurposes: row.allowed_purposes,
        version: row.version,
      };
    });
  }

  async deleteFactVersions(userId: string, key: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await transaction.query('DELETE FROM knowledge_facts WHERE user_id = $1 AND key = $2', [userId, key]);
      await transaction.query('DELETE FROM knowledge_fact_versions WHERE user_id = $1 AND key = $2', [userId, key]);
    });
  }

  async nextDocumentVersion(userId: string, type: StoredDocument['type']): Promise<number> {
    const result = await this.db.query<{ next_version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
       FROM documents WHERE user_id = $1 AND type = $2`,
      [userId, type],
    );
    const version = result.rows[0]?.next_version;
    if (version === undefined) throw new Error('Unable to allocate a document version');
    return version;
  }

  async saveDocument(document: StoredDocument): Promise<void> {
    await this.db.query(
      `INSERT INTO documents (
         id, user_id, type, version, object_key, sha256, mime_type,
         approved, malware_scan_status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        document.id,
        document.userId,
        document.type,
        document.version,
        document.objectKey,
        document.sha256,
        document.mimeType,
        document.approved,
        document.malwareScanStatus,
      ],
    );
  }

  async getLatestDocument(
    userId: string,
    type: StoredDocument['type'],
  ): Promise<StoredDocument | null> {
    const result = await this.db.query<DocumentRow>(
      `SELECT id, user_id, type, version, object_key, sha256, mime_type,
              approved, malware_scan_status
       FROM documents WHERE user_id = $1 AND type = $2
       ORDER BY version DESC LIMIT 1`,
      [userId, type],
    );
    const row = result.rows[0];
    return row === undefined ? null : storedDocument(row);
  }

  async setDocumentScanStatus(
    documentId: string,
    userId: string,
    status: StoredDocument['malwareScanStatus'],
  ): Promise<void> {
    const result = await this.db.query(
      `UPDATE documents SET malware_scan_status = $3
       WHERE id = $1 AND user_id = $2`,
      [documentId, userId, status],
    );
    if (result.affectedRows !== 1) throw new Error('CV document not found');
  }

  async approveDocument(documentId: string, userId: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE documents SET approved = true
       WHERE id = $1 AND user_id = $2 AND malware_scan_status = 'clean'`,
      [documentId, userId],
    );
    if (result.affectedRows !== 1) throw new Error('CV has not passed safety checks');
  }
}
