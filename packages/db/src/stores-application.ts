import { checkpointSchema } from '@job-agent/browser-core';
import { canTransition } from '@job-agent/application';
import type {
  ApplicationFieldRecord,
  ApplicationFieldRepository,
  ApplicationRecord,
  ApplicationRepository,
  ApplicationStores,
  ApprovalRecord,
  ApprovalRepository,
  ArtifactRecord,
  AttemptRecord,
  AttemptRepository,
  BrowserArtifactRepository,
  LedgerStatus,
  QuestionRecord,
  QuestionRepository,
  ReceiptRecord,
  ReceiptRepository,
  SubmissionLedgerRepository,
  SubmitIntentRecord,
  SubmitIntentRepository,
} from '@job-agent/application';
import type { ApplicationState } from '@job-agent/domain';
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

function mapApplication(row: SqlRow): ApplicationRecord {
  return {
    id: asText(row.id),
    userId: asText(row.user_id),
    jobId: asText(row.job_id),
    state: asText(row.current_state, 'DISCOVERED') as ApplicationState,
    stateVersion: asNumber(row.state_version, 1),
    submitMode:
      asText(row.submit_mode, 'approval_required') === 'auto' ? 'auto' : 'approval_required',
    targetKind: 'fake_ats',
    adapterId: asNullableText(row.adapter_id),
    adapterVersion: asNullableText(row.adapter_version),
    pauseReason: asNullableText(row.pause_reason),
    takeoverRequestedAt: isoOrNull(row.takeover_requested_at),
    currentAttemptNo: asNumber(row.current_attempt_no, 0),
    createdAt: iso(row.created_at, new Date().toISOString()),
    updatedAt: iso(row.updated_at, new Date().toISOString()),
  };
}

const applicationColumns = `id, user_id, job_id, current_state, state_version, submit_mode,
  adapter_id, adapter_version, pause_reason, takeover_requested_at, current_attempt_no,
  created_at, updated_at`;

async function appendEvent(
  executor: SqlExecutor,
  input: {
    applicationId: string;
    eventType: string;
    actor: 'user' | 'system' | 'worker';
    correlationId: string;
    payload: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO application_events (
       id, application_id, sequence, event_type, actor, correlation_id, payload_json, occurred_at
     )
     SELECT $1, $2,
            COALESCE((SELECT MAX(sequence) FROM application_events WHERE application_id = $2), 0) + 1,
            $3, $4, $5, $6::jsonb, $7`,
    [
      uuidv7(),
      input.applicationId,
      input.eventType,
      input.actor,
      input.correlationId,
      JSON.stringify(input.payload),
      input.now,
    ],
  );
}

export class SqlApplicationRepository implements ApplicationRepository {
  constructor(private readonly db: SqlDatabase) {}

  async create(input: Parameters<ApplicationRepository['create']>[0]): Promise<ApplicationRecord> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO applications (
           id, user_id, job_id, match_run_id, current_state, policy_version, submit_mode,
           adapter_id, adapter_version, target_kind, correlation_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'QUEUED', $5, 'approval_required', $6, $7, 'fake_ats', $8, $9, $9)
         ON CONFLICT (user_id, job_id) DO NOTHING
         RETURNING ${applicationColumns}`,
        [
          uuidv7(),
          input.userId,
          input.jobId,
          input.matchRunId,
          input.policyVersion,
          input.adapterId,
          input.adapterVersion,
          input.correlationId,
          input.now,
        ],
      );
      const row = firstRow(inserted);
      if (row !== null) {
        await appendEvent(tx, {
          applicationId: asText(row.id),
          eventType: 'application.created',
          actor: 'system',
          correlationId: input.correlationId,
          payload: { adapterId: input.adapterId, adapterVersion: input.adapterVersion },
          now: input.now,
        });
        return mapApplication(row);
      }
      const existing = await tx.query(
        `SELECT ${applicationColumns} FROM applications WHERE user_id = $1 AND job_id = $2`,
        [input.userId, input.jobId],
      );
      return mapApplication(requireRow(existing, 'The application could not be created'));
    });
  }

  async get(applicationId: string): Promise<ApplicationRecord | null> {
    const result = await this.db.query(
      `SELECT ${applicationColumns} FROM applications WHERE id = $1`,
      [applicationId],
    );
    const row = firstRow(result);
    return row === null ? null : mapApplication(row);
  }

  async findByJob(userId: string, jobId: string): Promise<ApplicationRecord | null> {
    const result = await this.db.query(
      `SELECT ${applicationColumns} FROM applications WHERE user_id = $1 AND job_id = $2`,
      [userId, jobId],
    );
    const row = firstRow(result);
    return row === null ? null : mapApplication(row);
  }

  async list(userId: string, limit: number): Promise<ApplicationRecord[]> {
    const result = await this.db.query(
      `SELECT ${applicationColumns} FROM applications WHERE user_id = $1
        ORDER BY updated_at DESC LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map(mapApplication);
  }

  async transition(
    input: Parameters<ApplicationRepository['transition']>[0],
  ): Promise<ApplicationRecord> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query(
        `SELECT ${applicationColumns} FROM applications WHERE id = $1`,
        [input.applicationId],
      );
      const record = mapApplication(requireRow(current, 'Unknown application'));
      if (record.state === input.to) return record;
      if (!canTransition(record.state, input.to)) {
        throw new Error(`Invalid application transition: ${record.state} -> ${input.to}`);
      }
      const updated = await tx.query(
        `UPDATE applications
            SET current_state = $2, state_version = state_version + 1,
                pause_reason = $3, updated_at = $4
          WHERE id = $1
        RETURNING ${applicationColumns}`,
        [
          input.applicationId,
          input.to,
          input.pauseReason === undefined ? record.pauseReason : input.pauseReason,
          input.now,
        ],
      );
      await appendEvent(tx, {
        applicationId: input.applicationId,
        eventType: `state.${input.to}`,
        actor: input.actor,
        correlationId: input.correlationId,
        payload: { from: record.state, to: input.to, reason: input.reason },
        now: input.now,
      });
      return mapApplication(requireRow(updated, 'The application could not be updated'));
    });
  }

  async setTakeover(
    input: Parameters<ApplicationRepository['setTakeover']>[0],
  ): Promise<ApplicationRecord> {
    const result = await this.db.query(
      `UPDATE applications SET takeover_requested_at = $2, updated_at = $3 WHERE id = $1
       RETURNING ${applicationColumns}`,
      [input.applicationId, input.requested ? input.now : null, input.now],
    );
    return mapApplication(requireRow(result, 'Unknown application'));
  }
}

function mapAttempt(row: SqlRow): AttemptRecord {
  const rawCheckpoint = asRecord(row.checkpoint_json);
  const parsed = checkpointSchema.safeParse(rawCheckpoint);
  return {
    id: asText(row.id),
    applicationId: asText(row.application_id),
    attemptNo: asNumber(row.attempt_no, 1),
    adapterId: asText(row.adapter_id),
    adapterVersion: asText(row.adapter_version),
    targetOrigin: asText(row.target_origin),
    status: asText(row.status, 'running') as AttemptRecord['status'],
    pauseReason: asNullableText(row.pause_reason),
    checkpoint: parsed.success ? parsed.data : null,
    answerManifestHash: asNullableText(row.answer_manifest_hash),
    leaseOwner: asNullableText(row.lease_owner),
    leaseExpiresAt: isoOrNull(row.lease_expires_at),
    startedAt: iso(row.started_at, new Date().toISOString()),
    finishedAt: isoOrNull(row.finished_at),
  };
}

const attemptColumns = `id, application_id, attempt_no, adapter_id, adapter_version, target_origin,
  status, pause_reason, checkpoint_json, answer_manifest_hash, lease_owner, lease_expires_at,
  started_at, finished_at`;

export class SqlAttemptRepository implements AttemptRepository {
  constructor(private readonly db: SqlDatabase) {}

  async create(input: Parameters<AttemptRepository['create']>[0]): Promise<AttemptRecord> {
    return this.db.transaction(async (tx) => {
      const next = await tx.query(
        `UPDATE applications SET current_attempt_no = current_attempt_no + 1, updated_at = $2
          WHERE id = $1 RETURNING current_attempt_no`,
        [input.applicationId, input.now],
      );
      const attemptNo = asNumber(requireRow(next, 'Unknown application').current_attempt_no, 1);
      const inserted = await tx.query(
        `INSERT INTO application_attempts (
           id, application_id, attempt_no, adapter_id, adapter_version, target_origin, status,
           started_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $7)
         RETURNING ${attemptColumns}`,
        [
          uuidv7(),
          input.applicationId,
          attemptNo,
          input.adapterId,
          input.adapterVersion,
          input.targetOrigin,
          input.now,
        ],
      );
      return mapAttempt(requireRow(inserted, 'The attempt could not be created'));
    });
  }

  async get(attemptId: string): Promise<AttemptRecord | null> {
    const result = await this.db.query(
      `SELECT ${attemptColumns} FROM application_attempts WHERE id = $1`,
      [attemptId],
    );
    const row = firstRow(result);
    return row === null ? null : mapAttempt(row);
  }

  async current(applicationId: string): Promise<AttemptRecord | null> {
    const result = await this.db.query(
      `SELECT ${attemptColumns} FROM application_attempts WHERE application_id = $1
        ORDER BY attempt_no DESC LIMIT 1`,
      [applicationId],
    );
    const row = firstRow(result);
    return row === null ? null : mapAttempt(row);
  }

  async saveCheckpoint(input: Parameters<AttemptRepository['saveCheckpoint']>[0]): Promise<void> {
    await this.db.query(
      `UPDATE application_attempts
          SET checkpoint_json = $2::jsonb, checkpoint_version = checkpoint_version + 1,
              status = $3, pause_reason = $4, updated_at = $5
        WHERE id = $1`,
      [
        input.attemptId,
        JSON.stringify(input.checkpoint),
        input.status,
        input.pauseReason,
        input.now,
      ],
    );
  }

  async setStatus(input: Parameters<AttemptRepository['setStatus']>[0]): Promise<void> {
    await this.db.query(
      `UPDATE application_attempts
          SET status = $2, pause_reason = $3, updated_at = $4,
              finished_at = CASE WHEN $2 IN ('submitted','failed','cancelled') THEN $4 ELSE finished_at END
        WHERE id = $1`,
      [input.attemptId, input.status, input.pauseReason, input.now],
    );
  }

  async setManifestHash(attemptId: string, manifestHash: string, now: Date): Promise<void> {
    await this.db.query(
      `UPDATE application_attempts SET answer_manifest_hash = $2, updated_at = $3 WHERE id = $1`,
      [attemptId, manifestHash, now],
    );
  }

  async acquireLease(input: Parameters<AttemptRepository['acquireLease']>[0]): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE application_attempts
          SET lease_owner = $2, lease_expires_at = $3, updated_at = $4
        WHERE id = $1 AND (lease_expires_at IS NULL OR lease_expires_at <= $4)
        RETURNING id`,
      [
        input.attemptId,
        input.owner,
        new Date(input.now.getTime() + input.seconds * 1000),
        input.now,
      ],
    );
    return result.rows.length === 1;
  }

  async releaseLease(attemptId: string): Promise<void> {
    await this.db.query(
      `UPDATE application_attempts SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`,
      [attemptId],
    );
  }
}

function mapField(row: SqlRow): ApplicationFieldRecord {
  return {
    id: asText(row.id),
    attemptId: asText(row.attempt_id),
    stepId: asText(row.step_id),
    fieldKey: asText(row.field_key),
    label: asText(row.label),
    controlType: asText(row.control_type),
    required: asBoolean(row.required),
    sensitive: asBoolean(row.sensitive),
    mappedIntent: asNullableText(row.mapped_intent) as ApplicationFieldRecord['mappedIntent'],
    mappingConfidence: asNullableNumber(row.mapping_confidence),
    answerSource: asText(row.answer_source, 'unresolved') as ApplicationFieldRecord['answerSource'],
    answerHash: asNullableText(row.answer_hash),
    answerPreview: asNullableText(row.answer_preview),
    evidenceFactIds: asStringArray(row.evidence_fact_ids),
    validationStatus: asText(
      row.validation_status,
      'pending',
    ) as ApplicationFieldRecord['validationStatus'],
    validationMessage: asNullableText(row.validation_message),
  };
}

export class SqlApplicationFieldRepository implements ApplicationFieldRepository {
  constructor(private readonly db: SqlDatabase) {}

  async replaceStep(
    input: Parameters<ApplicationFieldRepository['replaceStep']>[0],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const field of input.fields) {
        await tx.query(
          `INSERT INTO application_fields (
             id, attempt_id, step_id, field_key, label, control_type, required, sensitive,
             mapped_intent, mapping_confidence, answer_source, answer_ciphertext, answer_hash,
             answer_preview, evidence_fact_ids, validation_status, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',$16,$16)
           ON CONFLICT (attempt_id, step_id, field_key) DO UPDATE SET
             label = EXCLUDED.label,
             control_type = EXCLUDED.control_type,
             required = EXCLUDED.required,
             sensitive = EXCLUDED.sensitive,
             mapped_intent = EXCLUDED.mapped_intent,
             mapping_confidence = EXCLUDED.mapping_confidence,
             answer_source = EXCLUDED.answer_source,
             answer_ciphertext = EXCLUDED.answer_ciphertext,
             answer_hash = EXCLUDED.answer_hash,
             answer_preview = EXCLUDED.answer_preview,
             evidence_fact_ids = EXCLUDED.evidence_fact_ids,
             validation_status = 'pending',
             validation_message = NULL,
             updated_at = EXCLUDED.updated_at`,
          [
            uuidv7(),
            input.attemptId,
            field.stepId,
            field.fieldKey,
            field.label,
            field.controlType,
            field.required,
            field.sensitive,
            field.mappedIntent,
            field.mappingConfidence,
            field.answerSource,
            field.answerCiphertext,
            field.answerHash,
            field.answerPreview,
            field.evidenceFactIds,
            input.now,
          ],
        );
      }
    });
  }

  async list(attemptId: string): Promise<ApplicationFieldRecord[]> {
    const result = await this.db.query(
      `SELECT id, attempt_id, step_id, field_key, label, control_type, required, sensitive,
              mapped_intent, mapping_confidence, answer_source, answer_hash, answer_preview,
              evidence_fact_ids, validation_status, validation_message
         FROM application_fields WHERE attempt_id = $1 ORDER BY step_id, field_key`,
      [attemptId],
    );
    return result.rows.map(mapField);
  }

  async readAnswers(
    attemptId: string,
  ): Promise<Array<{ fieldKey: string; ciphertext: Buffer | null }>> {
    const result = await this.db.query(
      `SELECT field_key, answer_ciphertext FROM application_fields WHERE attempt_id = $1`,
      [attemptId],
    );
    return result.rows.map((row) => ({
      fieldKey: asText(row.field_key),
      ciphertext:
        row.answer_ciphertext === null || row.answer_ciphertext === undefined
          ? null
          : Buffer.from(row.answer_ciphertext as Uint8Array),
    }));
  }

  async markValidation(
    input: Parameters<ApplicationFieldRepository['markValidation']>[0],
  ): Promise<void> {
    await this.db.query(
      `UPDATE application_fields
          SET validation_status = CASE WHEN $3 = 0 THEN 'accepted' ELSE 'rejected' END,
              validation_message = $4, updated_at = $5
        WHERE attempt_id = $1 AND step_id = $2`,
      [
        input.attemptId,
        input.stepId,
        input.messages.length,
        input.messages.length === 0 ? null : input.messages.join(' | ').slice(0, 400),
        input.now,
      ],
    );
  }
}

function mapQuestion(row: SqlRow): QuestionRecord {
  return {
    id: asText(row.id),
    applicationId: asText(row.application_id),
    attemptId: asText(row.attempt_id),
    stepId: asText(row.step_id),
    fieldKey: asText(row.field_key),
    reason: asText(row.reason),
    prompt: asText(row.prompt),
    responseKind: asText(row.response_kind, 'text') as QuestionRecord['responseKind'],
    allowedValues: asStringArray(row.allowed_values),
    state: asText(row.state, 'open') as QuestionRecord['state'],
    responseVersion: asNumber(row.response_version, 0),
    correlationId: asText(row.correlation_id),
    expiresAt: iso(row.expires_at, new Date().toISOString()),
    createdAt: iso(row.created_at, new Date().toISOString()),
    answeredAt: isoOrNull(row.answered_at),
  };
}

const questionColumns = `id, application_id, attempt_id, step_id, field_key, reason, prompt,
  response_kind, allowed_values, state, response_version, correlation_id, expires_at, created_at,
  answered_at`;

export class SqlQuestionRepository implements QuestionRepository {
  constructor(private readonly db: SqlDatabase) {}

  async open(input: Parameters<QuestionRepository['open']>[0]): Promise<QuestionRecord> {
    const existing = await this.db.query(
      `SELECT ${questionColumns} FROM application_questions
        WHERE attempt_id = $1 AND step_id = $2 AND field_key = $3 AND state = 'open'`,
      [input.attemptId, input.stepId, input.fieldKey],
    );
    const found = firstRow(existing);
    if (found !== null) return mapQuestion(found);
    const inserted = await this.db.query(
      `INSERT INTO application_questions (
         id, application_id, attempt_id, step_id, field_key, reason, prompt, response_kind,
         allowed_values, state, correlation_id, expires_at, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$11,$12)
       RETURNING ${questionColumns}`,
      [
        uuidv7(),
        input.applicationId,
        input.attemptId,
        input.stepId,
        input.fieldKey,
        input.reason,
        input.prompt,
        input.responseKind,
        input.allowedValues,
        input.correlationId,
        input.expiresAt,
        input.now,
      ],
    );
    return mapQuestion(requireRow(inserted, 'The question could not be recorded'));
  }

  async listOpen(applicationId: string): Promise<QuestionRecord[]> {
    const result = await this.db.query(
      `SELECT ${questionColumns} FROM application_questions
        WHERE application_id = $1 AND state = 'open' ORDER BY created_at`,
      [applicationId],
    );
    return result.rows.map(mapQuestion);
  }

  async get(questionId: string): Promise<QuestionRecord | null> {
    const result = await this.db.query(
      `SELECT ${questionColumns} FROM application_questions WHERE id = $1`,
      [questionId],
    );
    const row = firstRow(result);
    return row === null ? null : mapQuestion(row);
  }

  async answer(
    input: Parameters<QuestionRepository['answer']>[0],
  ): Promise<{ applied: boolean; question: QuestionRecord }> {
    const updated = await this.db.query(
      `UPDATE application_questions
          SET state = 'answered', answer_ciphertext = $3, answer_scope = $4,
              response_version = $2, answered_at = $5
        WHERE id = $1 AND state = 'open' AND response_version < $2
      RETURNING ${questionColumns}`,
      [input.questionId, input.responseVersion, input.ciphertext, input.scope, input.now],
    );
    const row = firstRow(updated);
    if (row !== null) return { applied: true, question: mapQuestion(row) };
    const existing = await this.db.query(
      `SELECT ${questionColumns} FROM application_questions WHERE id = $1`,
      [input.questionId],
    );
    return {
      applied: false,
      question: mapQuestion(requireRow(existing, 'Unknown question')),
    };
  }

  async markCompletedByUser(
    input: Parameters<QuestionRepository['markCompletedByUser']>[0],
  ): Promise<{ applied: boolean; question: QuestionRecord }> {
    // answer_ciphertext and answer_scope stay null on purpose: the user did this step themselves and
    // the agent holds no record of what they entered.
    const updated = await this.db.query(
      `UPDATE application_questions
          SET state = 'answered', answered_at = $2
        WHERE id = $1 AND state = 'open' AND response_kind = 'human_action'
      RETURNING ${questionColumns}`,
      [input.questionId, input.now],
    );
    const row = firstRow(updated);
    if (row !== null) return { applied: true, question: mapQuestion(row) };
    const existing = await this.db.query(
      `SELECT ${questionColumns} FROM application_questions WHERE id = $1`,
      [input.questionId],
    );
    return {
      applied: false,
      question: mapQuestion(requireRow(existing, 'Unknown question')),
    };
  }

  async supersedeOpen(attemptId: string, now: Date): Promise<number> {
    const result = await this.db.query(
      `UPDATE application_questions SET state = 'superseded', answered_at = $2
        WHERE attempt_id = $1 AND state = 'open' RETURNING id`,
      [attemptId, now],
    );
    return result.rows.length;
  }

  async readAnswers(attemptId: string): Promise<Array<{ fieldKey: string; ciphertext: Buffer }>> {
    const result = await this.db.query(
      `SELECT field_key, answer_ciphertext FROM application_questions
        WHERE attempt_id = $1 AND state = 'answered' AND answer_ciphertext IS NOT NULL`,
      [attemptId],
    );
    return result.rows.map((row) => ({
      fieldKey: asText(row.field_key),
      ciphertext: Buffer.from(row.answer_ciphertext as Uint8Array),
    }));
  }
}

function mapApproval(row: SqlRow): ApprovalRecord {
  return {
    id: asText(row.id),
    applicationId: asText(row.application_id),
    attemptId: asText(row.attempt_id),
    snapshotHash: asText(row.snapshot_hash),
    decision: asText(row.decision, 'rejected') === 'approved' ? 'approved' : 'rejected',
    reason: asNullableText(row.reason),
    correlationId: asText(row.correlation_id),
    createdAt: iso(row.created_at, new Date().toISOString()),
    expiresAt: iso(row.expires_at, new Date().toISOString()),
    consumedAt: isoOrNull(row.consumed_at),
  };
}

const approvalColumns = `id, application_id, attempt_id, snapshot_hash, decision, reason,
  correlation_id, created_at, expires_at, consumed_at`;

export class SqlApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: SqlDatabase) {}

  async record(
    input: Parameters<ApprovalRepository['record']>[0],
  ): Promise<{ created: boolean; approval: ApprovalRecord }> {
    return this.db.transaction(async (tx) => {
      if (input.decision === 'approved') {
        const existing = await tx.query(
          `SELECT ${approvalColumns} FROM approvals
            WHERE application_id = $1 AND snapshot_hash = $2 AND decision = 'approved'
              AND consumed_at IS NULL`,
          [input.applicationId, input.snapshotHash],
        );
        const found = firstRow(existing);
        // A replayed approval returns the original rather than creating a second one.
        if (found !== null) return { created: false, approval: mapApproval(found) };
      }
      const inserted = await tx.query(
        `INSERT INTO approvals (
           id, application_id, attempt_id, approver, snapshot_hash, decision, reason,
           correlation_id, created_at, expires_at
         ) VALUES ($1,$2,$3,'user',$4,$5,$6,$7,$8,$9)
         RETURNING ${approvalColumns}`,
        [
          uuidv7(),
          input.applicationId,
          input.attemptId,
          input.snapshotHash,
          input.decision,
          input.reason,
          input.correlationId,
          input.now,
          new Date(input.now.getTime() + input.ttlSeconds * 1000),
        ],
      );
      return {
        created: true,
        approval: mapApproval(requireRow(inserted, 'The decision could not be recorded')),
      };
    });
  }

  async liveApproval(applicationId: string, snapshotHash: string): Promise<ApprovalRecord | null> {
    const result = await this.db.query(
      `SELECT ${approvalColumns} FROM approvals
        WHERE application_id = $1 AND snapshot_hash = $2 AND decision = 'approved'
          AND consumed_at IS NULL`,
      [applicationId, snapshotHash],
    );
    const row = firstRow(result);
    return row === null ? null : mapApproval(row);
  }

  async latest(applicationId: string): Promise<ApprovalRecord | null> {
    const result = await this.db.query(
      `SELECT ${approvalColumns} FROM approvals WHERE application_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [applicationId],
    );
    const row = firstRow(result);
    return row === null ? null : mapApproval(row);
  }

  async consume(approvalId: string, now: Date): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE approvals SET consumed_at = $2
        WHERE id = $1 AND consumed_at IS NULL AND decision = 'approved' AND expires_at > $2
      RETURNING id`,
      [approvalId, now],
    );
    return result.rows.length === 1;
  }
}

function mapIntent(row: SqlRow): SubmitIntentRecord {
  return {
    id: asText(row.id),
    applicationId: asText(row.application_id),
    attemptId: asText(row.attempt_id),
    approvalId: asText(row.approval_id),
    tokenHash: asText(row.token_hash),
    snapshotHash: asText(row.snapshot_hash),
    targetOrigin: asText(row.target_origin),
    createdAt: iso(row.created_at, new Date().toISOString()),
    expiresAt: iso(row.expires_at, new Date().toISOString()),
    consumedAt: isoOrNull(row.consumed_at),
    result: asNullableText(row.result) as SubmitIntentRecord['result'],
  };
}

const intentColumns = `id, application_id, attempt_id, approval_id, token_hash, snapshot_hash,
  target_origin, created_at, expires_at, consumed_at, result`;

export class SqlSubmitIntentRepository implements SubmitIntentRepository {
  constructor(private readonly db: SqlDatabase) {}

  async issue(input: Parameters<SubmitIntentRepository['issue']>[0]): Promise<SubmitIntentRecord> {
    const inserted = await this.db.query(
      `INSERT INTO submit_intents (
         id, application_id, attempt_id, approval_id, token_hash, snapshot_hash, target_origin,
         created_at, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING ${intentColumns}`,
      [
        uuidv7(),
        input.applicationId,
        input.attemptId,
        input.approvalId,
        input.tokenHash,
        input.snapshotHash,
        input.targetOrigin,
        input.now,
        input.expiresAt,
      ],
    );
    return mapIntent(requireRow(inserted, 'The submit intent could not be issued'));
  }

  async active(attemptId: string): Promise<SubmitIntentRecord | null> {
    const result = await this.db.query(
      `SELECT ${intentColumns} FROM submit_intents WHERE attempt_id = $1 AND consumed_at IS NULL`,
      [attemptId],
    );
    const row = firstRow(result);
    return row === null ? null : mapIntent(row);
  }

  async consume(input: Parameters<SubmitIntentRepository['consume']>[0]): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE submit_intents SET consumed_at = $2, result = $3
        WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
      [input.intentId, input.now, input.result],
    );
    return result.rows.length === 1;
  }
}

export class SqlSubmissionLedgerRepository implements SubmissionLedgerRepository {
  constructor(private readonly db: SqlDatabase) {}

  async reserve(
    input: Parameters<SubmissionLedgerRepository['reserve']>[0],
  ): Promise<{ reserved: boolean; status: LedgerStatus }> {
    const inserted = await this.db.query(
      `INSERT INTO submission_ledger (
         id, user_id, application_id, attempt_id, local_date, mode, status, idempotency_key, reserved_at
       ) VALUES ($1,$2,$3,$4,$5,'fake_ats_approved','reserved',$6,$7)
       ON CONFLICT (application_id) DO NOTHING
       RETURNING status`,
      [
        uuidv7(),
        input.userId,
        input.applicationId,
        input.attemptId,
        input.localDate,
        input.idempotencyKey,
        input.now,
      ],
    );
    if (inserted.rows.length === 1) return { reserved: true, status: 'reserved' };
    return { reserved: false, status: await this.status(input.applicationId) };
  }

  async status(applicationId: string): Promise<LedgerStatus> {
    const result = await this.db.query(
      `SELECT status FROM submission_ledger WHERE application_id = $1`,
      [applicationId],
    );
    const row = firstRow(result);
    return row === null ? 'none' : (asText(row.status, 'none') as LedgerStatus);
  }

  async resolve(input: Parameters<SubmissionLedgerRepository['resolve']>[0]): Promise<void> {
    if (input.status === 'released') {
      await this.db.query(`DELETE FROM submission_ledger WHERE application_id = $1`, [
        input.applicationId,
      ]);
      return;
    }
    await this.db.query(
      `UPDATE submission_ledger SET status = $2, resolved_at = $3 WHERE application_id = $1`,
      [input.applicationId, input.status, input.now],
    );
  }
}

export class SqlReceiptRepository implements ReceiptRepository {
  constructor(private readonly db: SqlDatabase) {}

  async record(input: Parameters<ReceiptRepository['record']>[0]): Promise<ReceiptRecord> {
    const inserted = await this.db.query(
      `INSERT INTO receipts (
         id, application_id, attempt_id, provider_reference, confirmation_url_hash, captured_at
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (application_id, provider_reference) DO UPDATE SET captured_at = receipts.captured_at
       RETURNING id, application_id, attempt_id, provider_reference, captured_at`,
      [
        uuidv7(),
        input.applicationId,
        input.attemptId,
        input.providerReference,
        input.confirmationUrlHash,
        input.now,
      ],
    );
    const row = requireRow(inserted, 'The receipt could not be recorded');
    return {
      id: asText(row.id),
      applicationId: asText(row.application_id),
      attemptId: asText(row.attempt_id),
      providerReference: asText(row.provider_reference),
      capturedAt: iso(row.captured_at, new Date().toISOString()),
    };
  }

  async get(applicationId: string): Promise<ReceiptRecord | null> {
    const result = await this.db.query(
      `SELECT id, application_id, attempt_id, provider_reference, captured_at
         FROM receipts WHERE application_id = $1 ORDER BY captured_at LIMIT 1`,
      [applicationId],
    );
    const row = firstRow(result);
    return row === null
      ? null
      : {
          id: asText(row.id),
          applicationId: asText(row.application_id),
          attemptId: asText(row.attempt_id),
          providerReference: asText(row.provider_reference),
          capturedAt: iso(row.captured_at, new Date().toISOString()),
        };
  }
}

export class SqlBrowserArtifactRepository implements BrowserArtifactRepository {
  constructor(private readonly db: SqlDatabase) {}

  async record(input: Parameters<BrowserArtifactRepository['record']>[0]): Promise<void> {
    await this.db.query(
      `INSERT INTO browser_artifacts (
         id, attempt_id, kind, object_key, sha256, redacted, bytes, retain_until, created_at
       ) VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8)`,
      [
        uuidv7(),
        input.attemptId,
        input.kind,
        input.objectKey,
        input.sha256,
        input.bytes,
        input.retainUntil,
        input.now,
      ],
    );
  }

  async list(attemptId: string): Promise<ArtifactRecord[]> {
    const result = await this.db.query(
      `SELECT id, attempt_id, kind, object_key, sha256, redacted, bytes, retain_until
         FROM browser_artifacts WHERE attempt_id = $1 ORDER BY created_at`,
      [attemptId],
    );
    return result.rows.map((row) => ({
      id: asText(row.id),
      attemptId: asText(row.attempt_id),
      kind: asText(row.kind, 'screenshot') as ArtifactRecord['kind'],
      objectKey: asText(row.object_key),
      sha256: asText(row.sha256),
      redacted: asBoolean(row.redacted, true),
      bytes: asNumber(row.bytes),
      retainUntil: iso(row.retain_until, new Date().toISOString()),
    }));
  }
}

export function createApplicationStores(db: SqlDatabase): ApplicationStores {
  return {
    applications: new SqlApplicationRepository(db),
    attempts: new SqlAttemptRepository(db),
    fields: new SqlApplicationFieldRepository(db),
    questions: new SqlQuestionRepository(db),
    approvals: new SqlApprovalRepository(db),
    submitIntents: new SqlSubmitIntentRepository(db),
    ledger: new SqlSubmissionLedgerRepository(db),
    receipts: new SqlReceiptRepository(db),
    artifacts: new SqlBrowserArtifactRepository(db),
  };
}
