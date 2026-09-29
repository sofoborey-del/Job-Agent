import type {
  EmailApplicationRecord,
  EmailApplicationRepository,
  EmailApplicationState,
  EmailApprovalRecord,
  EmailLedgerStatus,
  EmailReceiptRecord,
  SaveDraftInput,
} from '@job-agent/email-application';
import { v7 as uuidv7 } from 'uuid';

import {
  asBoolean,
  asNumber,
  asNullableText,
  asRecord,
  asText,
  firstRow,
  iso,
  isoOrNull,
  requireRow,
  type SqlDatabase,
  type SqlExecutor,
  type SqlRow,
} from './sql.js';

function mapApplication(row: SqlRow): EmailApplicationRecord {
  const documentId = asNullableText(row.attachment_document_id);
  const filename = asNullableText(row.attachment_filename);
  const sha256 = asNullableText(row.attachment_sha256);
  return {
    id: asText(row.id),
    userId: asText(row.user_id),
    jobId: asText(row.job_id),
    state: asText(row.state, 'awaiting_approval') as EmailApplicationState,
    recipient: asText(row.recipient),
    recipientDomain: asText(row.recipient_domain),
    subject: asText(row.subject),
    bodySha256: asText(row.body_sha256),
    bodyCharacters: asNumber(row.body_characters, 0),
    attachment:
      documentId === null || filename === null || sha256 === null
        ? null
        : { documentId, filename, sha256 },
    manifestHash: asText(row.manifest_hash),
    manifest: asRecord(row.manifest_json) as EmailApplicationRecord['manifest'],
    instruction: asRecord(row.instruction_json) as EmailApplicationRecord['instruction'],
    jobVersion: asNumber(row.job_version, 1),
    jobContentHash: asText(row.job_content_hash),
    closesAt: isoOrNull(row.closes_at),
    salaryGate: asText(row.salary_gate, 'unknown') as 'pass' | 'reject' | 'unknown',
    salaryOverride: asBoolean(row.salary_override),
    failureCode: asNullableText(row.failure_code),
    createdAt: iso(row.created_at, new Date().toISOString()),
    updatedAt: iso(row.updated_at, new Date().toISOString()),
  };
}

function mapApproval(row: SqlRow): EmailApprovalRecord {
  return {
    id: asText(row.id),
    emailApplicationId: asText(row.email_application_id),
    manifestHash: asText(row.manifest_hash),
    decision: asText(row.decision, 'rejected') === 'approved' ? 'approved' : 'rejected',
    approverChannel: asText(row.approver_channel, 'discord') === 'local' ? 'local' : 'discord',
    reason: asNullableText(row.reason),
    requestId: asNullableText(row.request_id),
    correlationId: asText(row.correlation_id),
    createdAt: iso(row.created_at, new Date().toISOString()),
    expiresAt: iso(row.expires_at, new Date().toISOString()),
    consumedAt: isoOrNull(row.consumed_at),
  };
}

function mapReceipt(row: SqlRow): EmailReceiptRecord {
  return {
    emailApplicationId: asText(row.email_application_id),
    provider: asText(row.provider),
    providerMessageId: asText(row.provider_message_id),
    providerThreadId: asNullableText(row.provider_thread_id),
    evidenceSource:
      asText(row.evidence_source, 'provider_receipt') === 'user_report'
        ? 'user_report'
        : 'provider_receipt',
    acceptedAt: iso(row.accepted_at, new Date().toISOString()),
  };
}

/** Statuses that occupy a slot in the day's cap. An unconfirmed send counts, deliberately. */
const consumingStatuses = ['reserved', 'sent', 'uncertain'];

export class SqlEmailApplicationRepository implements EmailApplicationRepository {
  constructor(private readonly db: SqlDatabase) {}

  async saveDraft(input: SaveDraftInput): Promise<EmailApplicationRecord> {
    const result = await this.db.query(
      `INSERT INTO email_applications (
         id, user_id, job_id, state, recipient, recipient_domain, subject,
         body_ciphertext, body_sha256, body_characters,
         attachment_document_id, attachment_filename, attachment_sha256,
         manifest_hash, manifest_json, instruction_json,
         job_version, job_content_hash, closes_at, salary_gate, salary_override,
         failure_code, created_at, updated_at
       ) VALUES (
         $1,$2,$3,'awaiting_approval',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
         NULL,$21,$21
       )
       ON CONFLICT (user_id, job_id) DO UPDATE SET
         state = 'awaiting_approval',
         recipient = EXCLUDED.recipient,
         recipient_domain = EXCLUDED.recipient_domain,
         subject = EXCLUDED.subject,
         body_ciphertext = EXCLUDED.body_ciphertext,
         body_sha256 = EXCLUDED.body_sha256,
         body_characters = EXCLUDED.body_characters,
         attachment_document_id = EXCLUDED.attachment_document_id,
         attachment_filename = EXCLUDED.attachment_filename,
         attachment_sha256 = EXCLUDED.attachment_sha256,
         manifest_hash = EXCLUDED.manifest_hash,
         manifest_json = EXCLUDED.manifest_json,
         instruction_json = EXCLUDED.instruction_json,
         job_version = EXCLUDED.job_version,
         job_content_hash = EXCLUDED.job_content_hash,
         closes_at = EXCLUDED.closes_at,
         salary_gate = EXCLUDED.salary_gate,
         salary_override = EXCLUDED.salary_override,
         failure_code = NULL,
         updated_at = EXCLUDED.updated_at
       -- A vacancy that has been sent, is being sent, or is waiting on an unconfirmed send is never
       -- overwritten by a fresh draft. Those rows are evidence of an outbound action.
       WHERE email_applications.state NOT IN ('sending', 'sent', 'send_uncertain')
       RETURNING *`,
      [
        uuidv7(),
        input.userId,
        input.jobId,
        input.recipient,
        input.recipientDomain,
        input.subject,
        input.bodyCiphertext,
        input.bodySha256,
        input.bodyCharacters,
        input.attachment.documentId,
        input.attachment.filename,
        input.attachment.sha256,
        input.manifestHash,
        JSON.stringify(input.manifest),
        JSON.stringify(input.instruction),
        input.jobVersion,
        input.jobContentHash,
        input.closesAt,
        input.salaryGate,
        input.salaryOverride,
        input.now,
      ],
    );
    return mapApplication(
      requireRow(result, 'This vacancy already has an email application that cannot be replaced'),
    );
  }

  async get(id: string): Promise<EmailApplicationRecord | null> {
    const row = firstRow(
      await this.db.query(`SELECT * FROM email_applications WHERE id = $1`, [id]),
    );
    return row === null ? null : mapApplication(row);
  }

  async findByJob(userId: string, jobId: string): Promise<EmailApplicationRecord | null> {
    const row = firstRow(
      await this.db.query(`SELECT * FROM email_applications WHERE user_id = $1 AND job_id = $2`, [
        userId,
        jobId,
      ]),
    );
    return row === null ? null : mapApplication(row);
  }

  async list(userId: string, limit: number): Promise<EmailApplicationRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM email_applications WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [userId, Math.max(1, Math.min(limit, 100))],
    );
    return result.rows.map(mapApplication);
  }

  async readBodyCiphertext(id: string): Promise<Buffer | null> {
    const row = firstRow(
      await this.db.query(`SELECT body_ciphertext FROM email_applications WHERE id = $1`, [id]),
    );
    const value = row?.body_ciphertext;
    if (value === null || value === undefined) return null;
    return Buffer.from(value as Uint8Array);
  }

  async setState(input: {
    id: string;
    state: EmailApplicationState;
    failureCode?: string | null;
    now: Date;
  }): Promise<EmailApplicationRecord> {
    const result = await this.db.query(
      `UPDATE email_applications
          SET state = $2,
              failure_code = CASE WHEN $4 THEN $3 ELSE failure_code END,
              updated_at = $5
        WHERE id = $1
      RETURNING *`,
      [
        input.id,
        input.state,
        input.failureCode ?? null,
        input.failureCode !== undefined,
        input.now,
      ],
    );
    return mapApplication(requireRow(result, 'That email application no longer exists'));
  }

  async recordDecision(input: {
    emailApplicationId: string;
    manifestHash: string;
    decision: 'approved' | 'rejected';
    approverChannel: 'discord' | 'local';
    reason: string | null;
    requestId: string | null;
    correlationId: string;
    ttlSeconds: number;
    now: Date;
  }): Promise<{ created: boolean; approval: EmailApprovalRecord }> {
    const existing = await this.findDecision(this.db, input);
    if (existing !== null) return { created: false, approval: existing };

    const inserted = await this.db.query(
      `INSERT INTO email_application_approvals (
         id, email_application_id, manifest_hash, decision, approver_channel, reason,
         request_id, correlation_id, created_at, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        uuidv7(),
        input.emailApplicationId,
        input.manifestHash,
        input.decision,
        input.approverChannel,
        input.reason,
        input.requestId,
        input.correlationId,
        input.now,
        new Date(input.now.getTime() + input.ttlSeconds * 1000),
      ],
    );
    const row = firstRow(inserted);
    if (row !== null) return { created: true, approval: mapApproval(row) };

    const raced = await this.findDecision(this.db, input);
    if (raced === null) throw new Error('The decision could not be recorded');
    return { created: false, approval: raced };
  }

  private async findDecision(
    executor: SqlExecutor,
    input: {
      emailApplicationId: string;
      manifestHash: string;
      decision: 'approved' | 'rejected';
      requestId: string | null;
    },
  ): Promise<EmailApprovalRecord | null> {
    if (input.requestId !== null) {
      const byRequest = firstRow(
        await executor.query(`SELECT * FROM email_application_approvals WHERE request_id = $1`, [
          input.requestId,
        ]),
      );
      if (byRequest !== null) return mapApproval(byRequest);
    }
    // A live approval for the same manifest is the same decision, even from a different command.
    if (input.decision !== 'approved') return null;
    return this.liveApproval(input.emailApplicationId, input.manifestHash);
  }

  async decisionByRequestId(requestId: string): Promise<EmailApprovalRecord | null> {
    const row = firstRow(
      await this.db.query(`SELECT * FROM email_application_approvals WHERE request_id = $1`, [
        requestId,
      ]),
    );
    return row === null ? null : mapApproval(row);
  }

  async liveApproval(
    emailApplicationId: string,
    manifestHash: string,
  ): Promise<EmailApprovalRecord | null> {
    const row = firstRow(
      await this.db.query(
        `SELECT * FROM email_application_approvals
          WHERE email_application_id = $1 AND manifest_hash = $2
            AND decision = 'approved' AND consumed_at IS NULL`,
        [emailApplicationId, manifestHash],
      ),
    );
    return row === null ? null : mapApproval(row);
  }

  async consumeApproval(approvalId: string, now: Date): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE email_application_approvals SET consumed_at = $2
        WHERE id = $1 AND consumed_at IS NULL
      RETURNING id`,
      [approvalId, now],
    );
    return result.rows.length === 1;
  }

  /**
   * One transaction: count the day's slots, then take one. The unique key on the application means
   * a second reservation for the same vacancy can never be created, whatever races around it.
   */
  async reserveSend(input: {
    userId: string;
    emailApplicationId: string;
    approvalId: string;
    localDate: string;
    dailyCap: number;
    now: Date;
  }): Promise<{
    reserved: boolean;
    status: EmailLedgerStatus;
    usedToday: number;
    capReached: boolean;
  }> {
    return this.db.transaction(async (tx) => {
      const counted = firstRow(
        await tx.query(
          `SELECT count(*)::int AS used FROM email_send_ledger
            WHERE user_id = $1 AND local_date = $2 AND status = ANY($3)`,
          [input.userId, input.localDate, consumingStatuses],
        ),
      );
      const usedToday = asNumber(counted?.used, 0);
      const existing = firstRow(
        await tx.query(`SELECT status FROM email_send_ledger WHERE email_application_id = $1`, [
          input.emailApplicationId,
        ]),
      );
      if (existing !== null) {
        return {
          reserved: false,
          status: asText(existing.status, 'reserved') as EmailLedgerStatus,
          usedToday,
          capReached: false,
        };
      }
      if (usedToday >= input.dailyCap) {
        return { reserved: false, status: 'none', usedToday, capReached: true };
      }
      const inserted = await tx.query(
        `INSERT INTO email_send_ledger (
           id, user_id, email_application_id, approval_id, local_date, status,
           idempotency_key, reserved_at
         ) VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7)
         ON CONFLICT (email_application_id) DO NOTHING
         RETURNING status`,
        [
          uuidv7(),
          input.userId,
          input.emailApplicationId,
          input.approvalId,
          input.localDate,
          `${input.emailApplicationId}:${input.approvalId}`,
          input.now,
        ],
      );
      if (inserted.rows.length === 1) {
        return { reserved: true, status: 'reserved', usedToday, capReached: false };
      }
      return { reserved: false, status: 'reserved', usedToday, capReached: false };
    });
  }

  async resolveSend(input: {
    emailApplicationId: string;
    status: 'sent' | 'uncertain' | 'released';
    now: Date;
  }): Promise<void> {
    if (input.status === 'released') {
      // Removed rather than marked, so a provider refusal does not spend one of the day's slots and
      // a fresh review can reserve again.
      await this.db.query(`DELETE FROM email_send_ledger WHERE email_application_id = $1`, [
        input.emailApplicationId,
      ]);
      return;
    }
    await this.db.query(
      `UPDATE email_send_ledger SET status = $2, resolved_at = $3 WHERE email_application_id = $1`,
      [input.emailApplicationId, input.status, input.now],
    );
  }

  async ledgerStatus(emailApplicationId: string): Promise<EmailLedgerStatus> {
    const row = firstRow(
      await this.db.query(`SELECT status FROM email_send_ledger WHERE email_application_id = $1`, [
        emailApplicationId,
      ]),
    );
    return row === null ? 'none' : (asText(row.status, 'none') as EmailLedgerStatus);
  }

  async recordReceipt(input: {
    emailApplicationId: string;
    provider: string;
    providerMessageId: string;
    providerThreadId: string | null;
    evidenceSource: 'provider_receipt' | 'user_report';
    acceptedAt: Date;
    now: Date;
  }): Promise<EmailReceiptRecord> {
    const inserted = await this.db.query(
      `INSERT INTO email_receipts (
         id, email_application_id, provider, provider_message_id, provider_thread_id,
         evidence_source, accepted_at, recorded_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (email_application_id) DO NOTHING
       RETURNING *`,
      [
        uuidv7(),
        input.emailApplicationId,
        input.provider,
        input.providerMessageId,
        input.providerThreadId,
        input.evidenceSource,
        input.acceptedAt,
        input.now,
      ],
    );
    const row = firstRow(inserted);
    if (row !== null) return mapReceipt(row);
    const existing = await this.receipt(input.emailApplicationId);
    if (existing === null) throw new Error('The receipt could not be recorded');
    return existing;
  }

  async receipt(emailApplicationId: string): Promise<EmailReceiptRecord | null> {
    const row = firstRow(
      await this.db.query(`SELECT * FROM email_receipts WHERE email_application_id = $1`, [
        emailApplicationId,
      ]),
    );
    return row === null ? null : mapReceipt(row);
  }
}
