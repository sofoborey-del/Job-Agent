import { randomBytes } from 'node:crypto';

import { fakeAtsAdapter } from '@job-agent/adapters';
import { ApplicationWorkflowService, type ApplicationStores } from '@job-agent/application';
import {
  checkSubmitEligibility,
  hashSubmitToken,
  manifestHash,
  type Checkpoint,
  type FieldInventory,
} from '@job-agent/browser-core';
import type { KnowledgeFact } from '@job-agent/domain';
import { FieldCipher, StaticEncryptionKeyProvider } from '@job-agent/security';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PGliteDatabase } from './sql.js';
import { createApplicationStores } from './stores-application.js';
import { createMigratedTestDatabase } from './testing.js';

const ORIGIN = 'http://127.0.0.1:3311';
const adapter = fakeAtsAdapter(ORIGIN);

let database: { db: PGliteDatabase; close: () => Promise<void> };
let stores: ApplicationStores;
let workflow: ApplicationWorkflowService;
let cipher: FieldCipher;
let userId: string;
let jobId: string;

/** Reads the one row a test expects, without a non-null assertion. */
function only<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}

/** Reads a stored checkpoint, failing the test loudly rather than asserting non-null. */
function checkpointOf(attempt: { checkpoint: Checkpoint | null } | null): Checkpoint {
  if (attempt?.checkpoint == null) throw new Error('expected a saved checkpoint');
  return attempt.checkpoint;
}

function fact(
  key: string,
  value: unknown,
  overrides: Partial<KnowledgeFact<unknown>> = {},
): KnowledgeFact<unknown> {
  return {
    id: uuidv7(),
    key,
    value,
    status: 'verified',
    source: 'user',
    sensitivity: 'normal',
    usePolicy: 'auto_fill',
    allowedPurposes: ['matching', 'application'],
    version: 1,
    ...overrides,
  };
}

const syntheticFacts: KnowledgeFact<unknown>[] = [
  fact('identity.first_name', 'Sam'),
  fact('identity.last_name', 'Tester'),
  fact('contact.email', 'sam.tester@example.test'),
  fact('contact.phone', '07700900000'),
  fact('experience.years_total', 6),
  fact('preferences.contract_type', ['Permanent']),
  fact('statement.supporting', 'A synthetic statement for the local fake ATS test suite.'),
];

/** The equal-opportunities step. Every field here is one only a person may answer. */
function sensitiveInventory(): FieldInventory {
  return {
    stepId: 'questions',
    url: `${ORIGIN}/apply/abc/questions`,
    pageFingerprint: 'e'.repeat(64),
    fields: [
      {
        fieldKey: 'disability',
        label: 'Do you consider yourself to have a disability?',
        controlType: 'radio',
        selector: '[name="disability"]',
        required: true,
        options: ['Yes', 'No', 'Prefer not to say'],
      },
      {
        fieldKey: 'ethnicity',
        label: 'Ethnic group, for diversity monitoring',
        controlType: 'select',
        selector: '[name="ethnicity"]',
        required: true,
        options: ['Prefer not to say', 'Group A'],
      },
    ],
    validationMessages: [],
    humanOnlyMarkers: [],
  };
}

function detailsInventory(overrides: Partial<FieldInventory> = {}): FieldInventory {
  return {
    stepId: 'details',
    url: `${ORIGIN}/apply/abc/details`,
    pageFingerprint: 'a'.repeat(64),
    fields: [
      {
        fieldKey: 'first_name',
        label: 'First name',
        controlType: 'text',
        selector: '[name="first_name"]',
        required: true,
        options: [],
      },
      {
        fieldKey: 'last_name',
        label: 'Last name',
        controlType: 'text',
        selector: '[name="last_name"]',
        required: true,
        options: [],
      },
      {
        fieldKey: 'email',
        label: 'Email address',
        controlType: 'email',
        selector: '[name="email"]',
        required: true,
        options: [],
      },
      {
        fieldKey: 'favourite_colour',
        label: 'Which colour best describes your working style?',
        controlType: 'text',
        selector: '[name="favourite_colour"]',
        required: false,
        options: [],
      },
    ],
    validationMessages: [],
    humanOnlyMarkers: [],
    ...overrides,
  };
}

async function seedJob(): Promise<string> {
  const companyId = uuidv7();
  const id = uuidv7();
  await database.db.query(
    `INSERT INTO companies (id, canonical_name) VALUES ($1, 'Example Council')`,
    [companyId],
  );
  await database.db.query(
    `INSERT INTO jobs (
       id, company_id, canonical_url, title, description, location_json, content_hash, fingerprint,
       version, status
     ) VALUES ($1, $2, $3, 'Information Governance Officer', 'Synthetic advert.',
       '{"text":"Glasgow"}'::jsonb, $4, $5, 1, 'open')`,
    [id, companyId, `https://myjobscotland.gov.uk/jobs/${id}`, 'c'.repeat(64), 'd'.repeat(64)],
  );
  return id;
}

async function startAttempt(): Promise<{ applicationId: string; attemptId: string }> {
  const started = await workflow.startAttempt({
    userId,
    jobId,
    matchRunId: null,
    policyVersion: 'test-policy',
    targetOrigin: ORIGIN,
  });
  return { applicationId: started.application.id, attemptId: started.attempt.id };
}

async function buildManifest(ids: { applicationId: string; attemptId: string }) {
  return workflow.buildManifest({
    applicationId: ids.applicationId,
    attemptId: ids.attemptId,
    jobId,
    jobVersion: 1,
    cvDocumentId: null,
    cvSha256: null,
  });
}

/** Drives the workflow to the point where a final action is possible. */
async function reachReadyToSubmit(): Promise<{
  applicationId: string;
  attemptId: string;
  hash: string;
}> {
  const ids = await startAttempt();
  await stores.applications.transition({
    applicationId: ids.applicationId,
    to: 'FILLING',
    actor: 'system',
    reason: 'test',
    correlationId: uuidv7(),
    now: new Date(),
  });
  await workflow.planStep({
    attemptId: ids.attemptId,
    inventory: detailsInventory(),
    facts: syntheticFacts,
    approvedDocument: null,
  });
  // The unknown control raised a question; the user answers it so the step can close.
  const open = await stores.questions.listOpen(ids.applicationId);
  for (const question of open) {
    await stores.questions.answer({
      questionId: question.id,
      responseVersion: 1,
      ciphertext: Buffer.from(
        JSON.stringify(
          cipher.encryptJson('Blue', `application-field:${ids.attemptId}:${question.fieldKey}`),
        ),
        'utf8',
      ),
      scope: 'application_only',
      now: new Date(),
    });
  }
  await stores.applications.transition({
    applicationId: ids.applicationId,
    to: 'FILLING',
    actor: 'user',
    reason: 'answered',
    correlationId: uuidv7(),
    now: new Date(),
  });
  await stores.applications.transition({
    applicationId: ids.applicationId,
    to: 'READY_FOR_REVIEW',
    actor: 'system',
    reason: 'review',
    correlationId: uuidv7(),
    now: new Date(),
  });
  const { hash } = await buildManifest(ids);
  await stores.applications.transition({
    applicationId: ids.applicationId,
    to: 'WAITING_APPROVAL',
    actor: 'system',
    reason: 'awaiting approval',
    correlationId: uuidv7(),
    now: new Date(),
  });
  await workflow.recordDecision({
    applicationId: ids.applicationId,
    attemptId: ids.attemptId,
    snapshotHash: hash,
    decision: 'approved',
    reason: null,
  });
  return { ...ids, hash };
}

beforeEach(async () => {
  database = await createMigratedTestDatabase();
  stores = createApplicationStores(database.db);
  cipher = new FieldCipher(
    new StaticEncryptionKeyProvider('test-v1', new Map([['test-v1', randomBytes(32)]])),
  );
  workflow = new ApplicationWorkflowService({ stores, cipher, adapter });
  userId = uuidv7();
  await database.db.query(
    `INSERT INTO users (id, timezone, status) VALUES ($1, 'Europe/London', 'active')`,
    [userId],
  );
  jobId = await seedJob();
});

afterEach(async () => {
  await database.close();
});

describe('planning a step', () => {
  it('answers only what verified facts support and asks about the rest', async () => {
    const ids = await startAttempt();
    const plan = await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: detailsInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    const filled = plan.actions.filter((action) => action.kind === 'fill');
    expect(filled.map((action) => action.fieldKey).sort()).toEqual([
      'email',
      'first_name',
      'last_name',
    ]);
    expect(plan.questionsOpened.map((question) => question.fieldKey)).toEqual(['favourite_colour']);
    expect(plan.questionsOpened[0]?.reason).toBe('unknown_field');
    expect(plan.pauseReason).toBe('questions_open');
    // The step is not advanced while a question is open.
    expect(plan.actions.some((action) => action.kind === 'click_next')).toBe(false);
  });

  it('stores an evidence reference and a hash for every answer, never the value', async () => {
    const ids = await startAttempt();
    await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: detailsInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    const fields = await stores.fields.list(ids.attemptId);
    const firstName = fields.find((field) => field.fieldKey === 'first_name');
    expect(firstName?.answerSource).toBe('verified_fact');
    expect(firstName?.evidenceFactIds).toHaveLength(1);
    expect(firstName?.answerHash).toMatch(/^[a-f0-9]{64}$/);
    const unknown = fields.find((field) => field.fieldKey === 'favourite_colour');
    expect(unknown?.answerSource).toBe('unresolved');
    expect(unknown?.answerHash).toBeNull();

    const rows = await database.db.query<{ answer_ciphertext: Uint8Array | null }>(
      'SELECT answer_ciphertext FROM application_fields WHERE attempt_id = $1',
      [ids.attemptId],
    );
    const serialised = rows.rows
      .map((row) =>
        row.answer_ciphertext === null ? '' : Buffer.from(row.answer_ciphertext).toString('utf8'),
      )
      .join(' ');
    expect(serialised).not.toContain('Sam');
    expect(serialised).not.toContain('07700900000');
  });

  it('pauses on a human-only step and never plans an action for it', async () => {
    const ids = await startAttempt();
    const plan = await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: {
        stepId: 'questions',
        url: `${ORIGIN}/apply/abc/questions`,
        pageFingerprint: 'b'.repeat(64),
        fields: [
          {
            fieldKey: 'disability',
            label: 'Do you consider yourself to have a disability?',
            controlType: 'radio',
            selector: '[name="disability"]',
            required: true,
            options: ['Yes', 'No'],
          },
          {
            fieldKey: 'criminal_record',
            label: 'Do you have any unspent criminal convictions?',
            controlType: 'radio',
            selector: '[name="criminal_record"]',
            required: true,
            options: ['Yes', 'No'],
          },
        ],
        validationMessages: [],
        humanOnlyMarkers: [],
      },
      facts: syntheticFacts,
      approvedDocument: null,
    });
    expect(plan.actions).toHaveLength(0);
    expect(plan.pauseReason).toBe('human_only_step');
    expect(plan.questionsOpened.every((question) => question.reason === 'sensitive_question')).toBe(
      true,
    );
    const application = await stores.applications.get(ids.applicationId);
    expect(application?.state).toBe('WAITING_TAKEOVER');
  });

  it('opens a question rather than uploading when no CV is approved', async () => {
    const ids = await startAttempt();
    const plan = await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: {
        stepId: 'documents',
        url: `${ORIGIN}/apply/abc/documents`,
        pageFingerprint: 'c'.repeat(64),
        fields: [
          {
            fieldKey: 'cv',
            label: 'Upload your CV',
            controlType: 'file',
            selector: '[name="cv"]',
            required: true,
            options: [],
          },
        ],
        validationMessages: [],
        humanOnlyMarkers: [],
      },
      facts: syntheticFacts,
      approvedDocument: null,
    });
    expect(plan.actions).toHaveLength(0);
    expect(plan.questionsOpened[0]?.reason).toBe('missing_evidence');
  });

  it('gives up on a validation loop and asks the user instead of retrying forever', async () => {
    const ids = await startAttempt();
    await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: detailsInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    const first = await workflow.recordStepResult({
      attemptId: ids.attemptId,
      stepId: 'details',
      validationMessages: ['Email address must be a valid email address.'],
      round: 1,
    });
    expect(first).toMatchObject({ retry: true, question: null });
    const last = await workflow.recordStepResult({
      attemptId: ids.attemptId,
      stepId: 'details',
      validationMessages: ['Email address must be a valid email address.'],
      round: 3,
    });
    expect(last.retry).toBe(false);
    expect(last.question?.reason).toBe('validation_rejected');
  });
});

describe('questions and replay', () => {
  it('treats a replayed answer as harmless', async () => {
    const ids = await startAttempt();
    await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: detailsInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    const question = only(await stores.questions.listOpen(ids.applicationId));
    const ciphertext = Buffer.from(
      JSON.stringify(
        cipher.encryptJson('Blue', `application-field:${ids.attemptId}:favourite_colour`),
      ),
      'utf8',
    );
    const first = await stores.questions.answer({
      questionId: question.id,
      responseVersion: 1,
      ciphertext,
      scope: 'application_only',
      now: new Date(),
    });
    const replay = await stores.questions.answer({
      questionId: question.id,
      responseVersion: 1,
      ciphertext,
      scope: 'application_only',
      now: new Date(),
    });
    expect(first.applied).toBe(true);
    expect(replay.applied).toBe(false);
    expect(replay.question.state).toBe('answered');
    expect(await stores.questions.listOpen(ids.applicationId)).toHaveLength(0);
  });

  it('uses the answer the user gave on the next plan for that step', async () => {
    const ids = await startAttempt();
    await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: detailsInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    const question = only(await stores.questions.listOpen(ids.applicationId));
    await stores.questions.answer({
      questionId: question.id,
      responseVersion: 1,
      ciphertext: Buffer.from(
        JSON.stringify(
          cipher.encryptJson('Blue', `application-field:${ids.attemptId}:favourite_colour`),
        ),
        'utf8',
      ),
      scope: 'application_only',
      now: new Date(),
    });
    const second = await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: detailsInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    expect(second.pauseReason).toBeNull();
    const colour = second.actions.find(
      (action) => action.kind === 'fill' && action.fieldKey === 'favourite_colour',
    );
    expect(colour).toMatchObject({ source: 'application_scoped_answer' });
    expect(second.actions.at(-1)?.kind).toBe('click_next');
  });
});

describe('approval and the submit guard', () => {
  it('binds approval to the exact manifest and permits exactly one final action', async () => {
    const ready = await reachReadyToSubmit();
    const prepared = await workflow.prepareSubmit({
      userId,
      applicationId: ready.applicationId,
      attemptId: ready.attemptId,
      currentSnapshotHash: ready.hash,
      targetOrigin: ORIGIN,
      isFakeTarget: true,
    });
    expect(prepared.allowed).toBe(true);
    if (!prepared.allowed) return;
    expect(hashSubmitToken(prepared.intentToken)).toHaveLength(64);

    // A second preparation is refused: the approval was consumed and the ledger reserved.
    const second = await workflow.prepareSubmit({
      userId,
      applicationId: ready.applicationId,
      attemptId: ready.attemptId,
      currentSnapshotHash: ready.hash,
      targetOrigin: ORIGIN,
      isFakeTarget: true,
    });
    expect(second).toMatchObject({ allowed: false });
  });

  it('refuses a stale manifest after an answer changes', async () => {
    const ready = await reachReadyToSubmit();
    // The form changes: a new required control appears, so the manifest no longer matches.
    await workflow.planStep({
      attemptId: ready.attemptId,
      inventory: detailsInventory({
        pageFingerprint: 'f'.repeat(64),
        fields: [
          ...detailsInventory().fields,
          {
            fieldKey: 'late_addition',
            label: 'New question added after you started',
            controlType: 'checkbox',
            selector: '[name="late_addition"]',
            required: true,
            options: [],
          },
        ],
      }),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    const rebuilt = await buildManifest({
      applicationId: ready.applicationId,
      attemptId: ready.attemptId,
    });
    expect(rebuilt.hash).not.toBe(ready.hash);

    const prepared = await workflow.prepareSubmit({
      userId,
      applicationId: ready.applicationId,
      attemptId: ready.attemptId,
      currentSnapshotHash: rebuilt.hash,
      targetOrigin: ORIGIN,
      isFakeTarget: true,
    });
    expect(prepared.allowed).toBe(false);

    // The new question also pauses the application, so prove the snapshot clause itself as well:
    // even in a ready state, an approval for the old manifest cannot cover the new one.
    const approval = await stores.approvals.latest(ready.applicationId);
    if (approval === null) throw new Error('expected an approval');
    expect(approval.snapshotHash).toBe(ready.hash);
    expect(
      checkSubmitEligibility({
        workflowState: 'READY_TO_SUBMIT',
        targetOrigin: ORIGIN,
        isFakeTarget: true,
        approval: {
          snapshotHash: approval.snapshotHash,
          decision: 'approved',
          consumedAt: null,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        currentSnapshotHash: rebuilt.hash,
        outstandingQuestions: 0,
        ledgerStatus: 'none',
        now: new Date(),
      }),
    ).toMatchObject({ allowed: false, reason: 'snapshot_changed' });
  });

  it('treats a replayed approval as the same approval, not a second one', async () => {
    const ids = await startAttempt();
    await stores.applications.transition({
      applicationId: ids.applicationId,
      to: 'FILLING',
      actor: 'system',
      reason: 't',
      correlationId: uuidv7(),
      now: new Date(),
    });
    await stores.applications.transition({
      applicationId: ids.applicationId,
      to: 'READY_FOR_REVIEW',
      actor: 'system',
      reason: 't',
      correlationId: uuidv7(),
      now: new Date(),
    });
    await stores.applications.transition({
      applicationId: ids.applicationId,
      to: 'WAITING_APPROVAL',
      actor: 'system',
      reason: 't',
      correlationId: uuidv7(),
      now: new Date(),
    });
    const { hash } = await buildManifest(ids);
    const first = await workflow.recordDecision({
      applicationId: ids.applicationId,
      attemptId: ids.attemptId,
      snapshotHash: hash,
      decision: 'approved',
      reason: null,
    });
    const replay = await workflow.recordDecision({
      applicationId: ids.applicationId,
      attemptId: ids.attemptId,
      snapshotHash: hash,
      decision: 'approved',
      reason: null,
    });
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    const rows = await database.db.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM approvals WHERE application_id = $1 AND decision = 'approved'`,
      [ids.applicationId],
    );
    expect(rows.rows[0]?.total).toBe(1);
  });

  it('refuses to submit while a question is still open', async () => {
    const ids = await startAttempt();
    await stores.applications.transition({
      applicationId: ids.applicationId,
      to: 'FILLING',
      actor: 'system',
      reason: 't',
      correlationId: uuidv7(),
      now: new Date(),
    });
    await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: detailsInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    const { hash } = await buildManifest(ids);
    await database.db.query(
      `UPDATE applications SET current_state = 'READY_TO_SUBMIT' WHERE id = $1`,
      [ids.applicationId],
    );
    await database.db.query(
      `INSERT INTO approvals (id, application_id, attempt_id, approver, snapshot_hash, decision, correlation_id, created_at, expires_at)
       VALUES ($1,$2,$3,'user',$4,'approved',$5, now(), now() + interval '10 minutes')`,
      [uuidv7(), ids.applicationId, ids.attemptId, hash, uuidv7()],
    );
    const prepared = await workflow.prepareSubmit({
      userId,
      applicationId: ids.applicationId,
      attemptId: ids.attemptId,
      currentSnapshotHash: hash,
      targetOrigin: ORIGIN,
      isFakeTarget: true,
    });
    expect(prepared).toMatchObject({ allowed: false, reason: 'questions_outstanding' });
  });
});

describe('crash recovery and submission outcomes', () => {
  it('a crash before the click leaves the reservation in place and refuses a fresh attempt', async () => {
    const ready = await reachReadyToSubmit();
    const prepared = await workflow.prepareSubmit({
      userId,
      applicationId: ready.applicationId,
      attemptId: ready.attemptId,
      currentSnapshotHash: ready.hash,
      targetOrigin: ORIGIN,
      isFakeTarget: true,
    });
    expect(prepared.allowed).toBe(true);

    // Simulate the process dying here: nothing recorded the outcome.
    const recovered = new ApplicationWorkflowService({ stores, cipher, adapter });
    const retry = await recovered.prepareSubmit({
      userId,
      applicationId: ready.applicationId,
      attemptId: ready.attemptId,
      currentSnapshotHash: ready.hash,
      targetOrigin: ORIGIN,
      isFakeTarget: true,
    });
    expect(retry).toMatchObject({ allowed: false });
    expect(await stores.ledger.status(ready.applicationId)).toBe('reserved');
  });

  it('a crash immediately after the click cannot produce a second submission', async () => {
    const ready = await reachReadyToSubmit();
    const prepared = await workflow.prepareSubmit({
      userId,
      applicationId: ready.applicationId,
      attemptId: ready.attemptId,
      currentSnapshotHash: ready.hash,
      targetOrigin: ORIGIN,
      isFakeTarget: true,
    });
    if (!prepared.allowed) throw new Error('expected a submit intent');
    await workflow.recordSubmissionOutcome({
      applicationId: ready.applicationId,
      attemptId: ready.attemptId,
      intentId: prepared.intentId,
      outcome: 'submitted',
      confirmationReference: 'FAKE-ATS-ABCD1234',
    });

    const afterRestart = new ApplicationWorkflowService({ stores, cipher, adapter });
    const retry = await afterRestart.prepareSubmit({
      userId,
      applicationId: ready.applicationId,
      attemptId: ready.attemptId,
      currentSnapshotHash: ready.hash,
      targetOrigin: ORIGIN,
      isFakeTarget: true,
    });
    expect(retry.allowed).toBe(false);
    expect(await stores.ledger.status(ready.applicationId)).toBe('confirmed');
    // The ledger alone refuses a second final action, independently of the workflow state.
    expect(
      checkSubmitEligibility({
        workflowState: 'READY_TO_SUBMIT',
        targetOrigin: ORIGIN,
        isFakeTarget: true,
        approval: {
          snapshotHash: ready.hash,
          decision: 'approved',
          consumedAt: null,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        currentSnapshotHash: ready.hash,
        outstandingQuestions: 0,
        ledgerStatus: 'confirmed',
        now: new Date(),
      }),
    ).toMatchObject({ allowed: false, reason: 'already_submitted' });
    const receipts = await database.db.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM receipts WHERE application_id = $1',
      [ready.applicationId],
    );
    expect(receipts.rows[0]?.total).toBe(1);
  });

  it('an unclear outcome goes to reconciliation and never retries by itself', async () => {
    const ready = await reachReadyToSubmit();
    const prepared = await workflow.prepareSubmit({
      userId,
      applicationId: ready.applicationId,
      attemptId: ready.attemptId,
      currentSnapshotHash: ready.hash,
      targetOrigin: ORIGIN,
      isFakeTarget: true,
    });
    if (!prepared.allowed) throw new Error('expected a submit intent');
    const result = await workflow.recordSubmissionOutcome({
      applicationId: ready.applicationId,
      attemptId: ready.attemptId,
      intentId: prepared.intentId,
      outcome: 'unknown',
      confirmationReference: null,
    });
    expect(result.state.state).toBe('SUBMISSION_UNKNOWN');
    expect(await stores.ledger.status(ready.applicationId)).toBe('unknown');
    const retry = await workflow.prepareSubmit({
      userId,
      applicationId: ready.applicationId,
      attemptId: ready.attemptId,
      currentSnapshotHash: ready.hash,
      targetOrigin: ORIGIN,
      isFakeTarget: true,
    });
    expect(retry).toMatchObject({ allowed: false });
  });

  it('a submit intent is single use', async () => {
    const ready = await reachReadyToSubmit();
    const prepared = await workflow.prepareSubmit({
      userId,
      applicationId: ready.applicationId,
      attemptId: ready.attemptId,
      currentSnapshotHash: ready.hash,
      targetOrigin: ORIGIN,
      isFakeTarget: true,
    });
    if (!prepared.allowed) throw new Error('expected a submit intent');
    expect(
      await stores.submitIntents.consume({
        intentId: prepared.intentId,
        result: 'submitted',
        now: new Date(),
      }),
    ).toBe(true);
    expect(
      await stores.submitIntents.consume({
        intentId: prepared.intentId,
        result: 'submitted',
        now: new Date(),
      }),
    ).toBe(false);
  });

  it('keeps the checkpoint across a restart and refuses to resume onto a changed form', async () => {
    const ids = await startAttempt();
    await stores.applications.transition({
      applicationId: ids.applicationId,
      to: 'FILLING',
      actor: 'system',
      reason: 't',
      correlationId: uuidv7(),
      now: new Date(),
    });
    await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: detailsInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });

    const reloaded = createApplicationStores(database.db);
    const attempt = await reloaded.attempts.get(ids.attemptId);
    expect(attempt?.checkpoint?.currentStepId).toBe('details');
    expect(attempt?.checkpoint?.pageFingerprint).toBe('a'.repeat(64));
    expect(JSON.stringify(attempt?.checkpoint)).not.toContain('Sam');

    const { checkpointStillValid } = await import('@job-agent/browser-core');
    expect(
      checkpointStillValid(
        checkpointOf(attempt),
        { adapterVersion: adapter.version, stepId: 'details', pageFingerprint: 'f'.repeat(64) },
        new Date(),
      ),
    ).toMatchObject({ ok: false, reason: 'form_changed' });
  });
});

describe('takeover, resume and duplicate delivery', () => {
  it('records manual takeover and refuses to resume while questions are open', async () => {
    const ids = await startAttempt();
    await stores.applications.transition({
      applicationId: ids.applicationId,
      to: 'FILLING',
      actor: 'system',
      reason: 't',
      correlationId: uuidv7(),
      now: new Date(),
    });
    await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: detailsInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    const taken = await workflow.requestTakeover({ applicationId: ids.applicationId });
    expect(taken.takeoverRequestedAt).not.toBeNull();

    const blocked = await workflow.resume({ applicationId: ids.applicationId });
    expect(blocked.resumed).toBe(false);
    expect(blocked.message).toContain('question');

    const question = only(await stores.questions.listOpen(ids.applicationId));
    await stores.questions.answer({
      questionId: question.id,
      responseVersion: 1,
      ciphertext: Buffer.from(
        JSON.stringify(
          cipher.encryptJson('Blue', `application-field:${ids.attemptId}:favourite_colour`),
        ),
        'utf8',
      ),
      scope: 'application_only',
      now: new Date(),
    });
    const resumed = await workflow.resume({ applicationId: ids.applicationId });
    expect(resumed.resumed).toBe(true);
    expect(resumed.state.state).toBe('FILLING');
    expect(resumed.state.takeoverRequestedAt).toBeNull();
  });

  /**
   * A human-only question cannot be answered, only confirmed as done. Without that confirmation the
   * run reaches a sensitive step and can never be resumed, because `resume` refuses while any
   * question is open. These tests pin the way out, and the guards on it.
   */
  it('resumes after the user confirms they completed the human-only step themselves', async () => {
    const ids = await startAttempt();
    const plan = await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: sensitiveInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    expect(plan.pauseReason).toBe('human_only_step');
    const open = await stores.questions.listOpen(ids.applicationId);
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((question) => question.responseKind === 'human_action')).toBe(true);

    // The deadlock this fixes: takeover alone leaves the questions open, so resume refuses.
    await workflow.requestTakeover({ applicationId: ids.applicationId });
    const blocked = await workflow.resume({ applicationId: ids.applicationId });
    expect(blocked.resumed).toBe(false);

    for (const question of open) {
      const confirmed = await workflow.confirmHumanStepCompleted({
        applicationId: ids.applicationId,
        questionId: question.id,
      });
      expect(confirmed.completed).toBe(true);
    }
    const resumed = await workflow.resume({ applicationId: ids.applicationId });
    expect(resumed.resumed).toBe(true);
    expect(resumed.state.state).toBe('FILLING');
  });

  it('keeps no record of what the user entered on a human-only step', async () => {
    const ids = await startAttempt();
    await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: sensitiveInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    await workflow.requestTakeover({ applicationId: ids.applicationId });
    const question = only(await stores.questions.listOpen(ids.applicationId));
    await workflow.confirmHumanStepCompleted({
      applicationId: ids.applicationId,
      questionId: question.id,
    });
    const row = await database.db.query<{ answer_ciphertext: Buffer | null; state: string }>(
      'SELECT answer_ciphertext, state FROM application_questions WHERE id = $1',
      [question.id],
    );
    expect(only(row.rows).state).toBe('answered');
    expect(only(row.rows).answer_ciphertext).toBeNull();
  });

  it('refuses to confirm a human-only step before takeover is active', async () => {
    const ids = await startAttempt();
    await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: sensitiveInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    const question = only(await stores.questions.listOpen(ids.applicationId));
    // planStep pauses into WAITING_TAKEOVER, but the user has not chosen to take over yet.
    await stores.applications.setTakeover({
      applicationId: ids.applicationId,
      requested: false,
      correlationId: uuidv7(),
      now: new Date(),
    });
    const refused = await workflow.confirmHumanStepCompleted({
      applicationId: ids.applicationId,
      questionId: question.id,
    });
    expect(refused.completed).toBe(false);
    expect(refused.reason).toBe('takeover_not_active');
  });

  it('refuses to confirm a question that expects a real answer', async () => {
    const ids = await startAttempt();
    await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: detailsInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    await workflow.requestTakeover({ applicationId: ids.applicationId });
    const question = only(await stores.questions.listOpen(ids.applicationId));
    expect(question.responseKind).not.toBe('human_action');
    const refused = await workflow.confirmHumanStepCompleted({
      applicationId: ids.applicationId,
      questionId: question.id,
    });
    expect(refused.completed).toBe(false);
    expect(refused.reason).toBe('not_a_human_step');
  });

  it('treats a replayed confirmation as harmless', async () => {
    const ids = await startAttempt();
    await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: sensitiveInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    await workflow.requestTakeover({ applicationId: ids.applicationId });
    const question = only(await stores.questions.listOpen(ids.applicationId));
    const first = await workflow.confirmHumanStepCompleted({
      applicationId: ids.applicationId,
      questionId: question.id,
    });
    const again = await workflow.confirmHumanStepCompleted({
      applicationId: ids.applicationId,
      questionId: question.id,
    });
    expect(first.completed).toBe(true);
    expect(again.completed).toBe(true);
    expect(again.message).toContain('already');
    const answered = await database.db.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM application_questions
        WHERE id = $1 AND state = 'answered'`,
      [question.id],
    );
    expect(only(answered.rows).total).toBe(1);
  });

  it('never creates two applications, or two live attempts, for the same job', async () => {
    const first = await startAttempt();
    // The same job arriving again is a duplicate delivery, not a retry: the running attempt stands.
    const second = await startAttempt();
    expect(second.applicationId).toBe(first.applicationId);
    expect(second.attemptId).toBe(first.attemptId);
    const rows = await database.db.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM applications WHERE user_id = $1 AND job_id = $2',
      [userId, jobId],
    );
    expect(rows.rows[0]?.total).toBe(1);
    const attempts = await database.db.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM application_attempts WHERE application_id = $1',
      [first.applicationId],
    );
    expect(attempts.rows[0]?.total).toBe(1);
  });

  it('starts a fresh attempt once the previous one has failed', async () => {
    const first = await startAttempt();
    await stores.attempts.setStatus({
      attemptId: first.attemptId,
      status: 'failed',
      pauseReason: null,
      now: new Date(),
    });
    await stores.applications.transition({
      applicationId: first.applicationId,
      to: 'RETRYABLE_FAILED',
      actor: 'system',
      reason: 'test',
      correlationId: uuidv7(),
      now: new Date(),
    });
    await stores.applications.transition({
      applicationId: first.applicationId,
      to: 'QUEUED',
      actor: 'system',
      reason: 'test',
      correlationId: uuidv7(),
      now: new Date(),
    });
    const second = await startAttempt();
    expect(second.applicationId).toBe(first.applicationId);
    expect(second.attemptId).not.toBe(first.attemptId);
  });

  it('produces a manifest that names evidence but no applicant value', async () => {
    const ids = await startAttempt();
    await workflow.planStep({
      attemptId: ids.attemptId,
      inventory: detailsInventory(),
      facts: syntheticFacts,
      approvedDocument: null,
    });
    const { manifest, hash } = await buildManifest(ids);
    expect(hash).toBe(manifestHash(manifest));
    const firstName = manifest.answers.find((answer) => answer.fieldKey === 'first_name');
    expect(firstName?.evidenceFactIds).toHaveLength(1);
    expect(firstName?.answerHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.outstandingQuestions).toBeGreaterThan(0);
    expect(manifest.adapterId).toBe('fake-ats');
  });
});
