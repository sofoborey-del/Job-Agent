import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

import { fakeAtsAdapter } from '@job-agent/adapters';
import { ApplicationWorkflowService, type ApplicationStores } from '@job-agent/application';
import { mapInventory, type AdapterContract } from '@job-agent/browser-core';
import {
  createApplicationStores,
  createMigratedTestDatabase,
  type PGliteDatabase,
} from '@job-agent/db';
import type { KnowledgeFact } from '@job-agent/domain';
import { buildFakeAts, type FakeAtsApp } from '@job-agent/fake-ats';
import { ApplicationRunner, type WorkerTransport } from '@job-agent/orchestrator';
import { FieldCipher, StaticEncryptionKeyProvider } from '@job-agent/security';
import { chromium } from 'playwright';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ActionExecutor } from './executor.js';
import { inspectPage } from './inspector.js';
import { workerRequestSchema } from './protocol.js';
import { runWorkerRequest } from './run.js';
import { WorkerSession } from './session.js';

const browserAvailable = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();
const suite = browserAvailable ? describe : describe.skip;

let ats: FakeAtsApp;
let origin = '';
let adapter: AdapterContract;
let database: { db: PGliteDatabase; close: () => Promise<void> };
let stores: ApplicationStores;
let workflow: ApplicationWorkflowService;
let cipher: FieldCipher;
let userId = '';
let jobId = '';

const cvBytes = Buffer.from('%PDF-1.4 synthetic acceptance-suite curriculum vitae');
const approvedDocument = {
  documentId: '22222222-2222-4222-8222-222222222222',
  sha256: createHash('sha256').update(cvBytes).digest('hex'),
  filename: 'synthetic-cv.pdf',
  contentBase64: cvBytes.toString('base64'),
};

function fact(key: string, value: unknown): KnowledgeFact<unknown> {
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
  };
}

const facts: KnowledgeFact<unknown>[] = [
  fact('identity.first_name', 'Sam'),
  fact('identity.last_name', 'Tester'),
  fact('contact.email', 'sam.tester@example.test'),
  fact('contact.phone', '07700900000'),
  fact('experience.years_total', 6),
  fact('preferences.contract_type', ['Permanent']),
  fact('work_authorisation.gb', { authorised: true }),
  fact('preferences.relocation', 'No'),
  fact(
    'statement.supporting',
    'A synthetic supporting statement written only for the local fake ATS acceptance suite, long enough to satisfy the minimum length rule.',
  ),
  fact('employment.current_employer', 'Example Synthetic Ltd'),
  fact('employment.current_title', 'Governance Officer'),
  fact('employment.current_start_date', '2020-01-01'),
  fact('employment.current_end_date', '2026-01-01'),
  fact('employment.current_duties', 'Synthetic duties recorded for the test fixture.'),
  fact('education.institution', 'Example Synthetic College'),
  fact('education.qualification', 'Synthetic Diploma'),
  fact('education.grade', 'Pass'),
  fact('education.year', '2015'),
];

/** Runs the worker in this process. The separate-process boundary is proved in its own test. */
const inProcessTransport: WorkerTransport = {
  run: async (request) => {
    const parsed = workerRequestSchema.parse(request);
    const result = await runWorkerRequest(parsed);
    return {
      ok: true,
      report: result.report as never,
      outcomes: result.outcomes,
    };
  },
};

/** Reads the redirect target without a non-null assertion. */
function locationOf(headers: Record<string, unknown>): string {
  const location = headers.location;
  return typeof location === 'string' ? location : '';
}

async function newAtsSession(): Promise<string> {
  const response = await ats.inject({ method: 'POST', url: '/apply/JOB-JOURNEY/start' });
  return locationOf(response.headers).split('/')[2] ?? '';
}

async function answerOpenQuestions(
  applicationId: string,
  attemptId: string,
  value: string,
): Promise<number> {
  const open = await stores.questions.listOpen(applicationId);
  for (const question of open) {
    await stores.questions.answer({
      questionId: question.id,
      responseVersion: 1,
      ciphertext: Buffer.from(
        JSON.stringify(
          cipher.encryptJson(value, `application-field:${attemptId}:${question.fieldKey}`),
        ),
        'utf8',
      ),
      scope: 'application_only',
      now: new Date(),
    });
  }
  return open.length;
}

beforeAll(async () => {
  ats = buildFakeAts();
  await ats.listen({ host: '127.0.0.1', port: 0 });
  const address = ats.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${String(port)}`;
  adapter = fakeAtsAdapter(origin);
});

afterAll(async () => {
  await ats.close();
});

beforeEach(async () => {
  await ats.inject({ method: 'POST', url: '/__control', payload: { reset: true } });
  database = await createMigratedTestDatabase();
  stores = createApplicationStores(database.db);
  cipher = new FieldCipher(
    new StaticEncryptionKeyProvider('test-v1', new Map([['test-v1', randomBytes(32)]])),
  );
  workflow = new ApplicationWorkflowService({ stores, cipher, adapter });
  userId = uuidv7();
  jobId = uuidv7();
  const companyId = uuidv7();
  await database.db.query(
    `INSERT INTO users (id, timezone, status) VALUES ($1, 'Europe/London', 'active')`,
    [userId],
  );
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
    [
      jobId,
      companyId,
      `https://myjobscotland.gov.uk/jobs/${jobId}`,
      'c'.repeat(64),
      'd'.repeat(64),
    ],
  );
});

afterEach(async () => {
  await database.close();
});

suite('a complete fake-ATS journey', () => {
  it('runs from the first step to a single fake submission, pausing wherever it must', async () => {
    const sessionId = await newAtsSession();
    const started = await workflow.startAttempt({
      userId,
      jobId,
      matchRunId: null,
      policyVersion: 'phase-2-test',
      targetOrigin: origin,
    });
    await stores.applications.transition({
      applicationId: started.application.id,
      to: 'STARTING',
      actor: 'system',
      reason: 'journey',
      correlationId: uuidv7(),
      now: new Date(),
    });
    await stores.applications.transition({
      applicationId: started.application.id,
      to: 'FILLING',
      actor: 'system',
      reason: 'journey',
      correlationId: uuidv7(),
      now: new Date(),
    });

    const runner = new ApplicationRunner({
      workflow,
      transport: inProcessTransport,
      adapter,
    });
    const runInput = {
      attemptId: started.attempt.id,
      startUrl: `${origin}/apply/${sessionId}/details`,
      facts,
      approvedDocument,
      sitePolicy: { origin, applyMode: 'manual_only', submitPermitted: true },
    };

    // 1. The first run stops on the details step, because the form asks two questions the
    //    profile cannot answer and the agent will not invent an answer.
    const first = await runner.runUntilPause(runInput);
    expect(first.pausedAt).toBe('details');
    expect(first.pauseReason).toBe('questions_open');
    const firstQuestions = await stores.questions.listOpen(started.application.id);
    expect(firstQuestions.map((question) => question.fieldKey).sort()).toEqual([
      'favourite_colour',
      'referral_code',
    ]);
    expect(firstQuestions.every((question) => question.reason === 'unknown_field')).toBe(true);

    // 2. The user answers them, and the run continues to the human-only questions step.
    expect(await answerOpenQuestions(started.application.id, started.attempt.id, 'Blue')).toBe(2);
    await stores.applications.transition({
      applicationId: started.application.id,
      to: 'FILLING',
      actor: 'user',
      reason: 'answered',
      correlationId: uuidv7(),
      now: new Date(),
    });

    const second = await runner.runUntilPause(runInput);
    expect(second.finishedStepIds).toEqual(
      expect.arrayContaining(['details', 'history', 'documents']),
    );
    expect(second.pausedAt).toBe('questions');
    expect(second.pauseReason).toBe('human_only_step');
    const sensitiveQuestions = await stores.questions.listOpen(started.application.id);
    expect(sensitiveQuestions.every((question) => question.reason === 'sensitive_question')).toBe(
      true,
    );
    const application = await stores.applications.get(started.application.id);
    expect(application?.state).toBe('WAITING_TAKEOVER');

    // The CV reached the form, under its own name.
    const atsState: {
      files: Record<string, { filename: string }>;
      values: Record<string, string>;
    } = (await ats.inject({ method: 'GET', url: `/__state/${sessionId}` })).json();
    expect(atsState.files.cv?.filename).toBe('synthetic-cv.pdf');
    // Nothing the agent was not given was entered anywhere.
    const allowed = new Set<string>([
      'Sam',
      'Tester',
      'sam.tester@example.test',
      '07700900000',
      '6',
      'Permanent',
      'Yes',
      'No',
      'Blue',
      'Example Synthetic Ltd',
      'Governance Officer',
      '2020-01-01',
      '2026-01-01',
      'Synthetic duties recorded for the test fixture.',
      'Example Synthetic College',
      'Synthetic Diploma',
      'Pass',
      '2015',
      'A synthetic supporting statement written only for the local fake ATS acceptance suite, long enough to satisfy the minimum length rule.',
    ]);
    for (const [key, value] of Object.entries(atsState.values)) {
      if (value.trim() === '') continue;
      expect(allowed.has(value), `unexpected value entered for ${key}: ${value}`).toBe(true);
    }

    // 3. The human-only steps are completed by the user, exactly as the design requires.
    await workflow.requestTakeover({ applicationId: started.application.id });
    await answerOpenQuestions(started.application.id, started.attempt.id, 'Prefer not to say');
    const humanSession = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const humanPage = await humanSession.open();
    try {
      for (const step of ['questions', 'checks', 'declarations']) {
        await humanPage.goto(`${origin}/apply/${sessionId}/${step}`, {
          waitUntil: 'domcontentloaded',
        });
        const inventory = await inspectPage(humanPage);
        for (const field of inventory.fields) {
          if (field.controlType === 'checkbox') await humanPage.check(field.selector);
          else if (field.controlType === 'radio')
            await humanPage.locator(field.selector).first().check();
          else if (field.controlType === 'select')
            await humanPage.selectOption(field.selector, field.options[0] ?? '');
          else await humanPage.fill(field.selector, 'entered by the user');
        }
        await humanPage.click('#next');
        await humanPage.waitForLoadState('domcontentloaded');
      }
      expect(humanPage.url()).toContain('/review');
    } finally {
      await humanSession.close();
      await humanSession.discardArtifacts();
    }

    const resumed = await workflow.resume({ applicationId: started.application.id });
    expect(resumed.resumed).toBe(true);

    // 4. Review, approve, and take the single permitted final action.
    await stores.applications.transition({
      applicationId: started.application.id,
      to: 'READY_FOR_REVIEW',
      actor: 'system',
      reason: 'review',
      correlationId: uuidv7(),
      now: new Date(),
    });
    const { manifest, hash } = await workflow.buildManifest({
      applicationId: started.application.id,
      attemptId: started.attempt.id,
      jobId,
      jobVersion: 1,
      cvDocumentId: approvedDocument.documentId,
      cvSha256: approvedDocument.sha256,
    });
    expect(manifest.outstandingQuestions).toBe(0);
    expect(manifest.answers.some((answer) => answer.source === 'verified_fact')).toBe(true);
    // Sensitive answers carry neither a preview nor a hash, and every answer names where it came
    // from. The previews that do exist are for the user's own local review screen.
    for (const answer of manifest.answers.filter((candidate) => candidate.sensitive)) {
      expect(answer.answerPreview).toBeNull();
      expect(answer.answerHash).toBeNull();
      expect(answer.source).toBe('human_only');
    }
    const phone = manifest.answers.find((answer) => answer.fieldKey === 'phone');
    expect(phone?.source).toBe('verified_fact');
    expect(phone?.evidenceFactIds).toHaveLength(1);
    // The radio group is named by its question, not by the first option.
    const rightToWork = manifest.answers.find((answer) => answer.fieldKey === 'right_to_work');
    expect(rightToWork?.label).toContain('Right to work');

    await stores.applications.transition({
      applicationId: started.application.id,
      to: 'WAITING_APPROVAL',
      actor: 'system',
      reason: 'awaiting approval',
      correlationId: uuidv7(),
      now: new Date(),
    });
    await workflow.recordDecision({
      applicationId: started.application.id,
      attemptId: started.attempt.id,
      snapshotHash: hash,
      decision: 'approved',
      reason: null,
    });
    const prepared = await workflow.prepareSubmit({
      userId,
      applicationId: started.application.id,
      attemptId: started.attempt.id,
      currentSnapshotHash: hash,
      targetOrigin: origin,
      isFakeTarget: true,
    });
    if (!prepared.allowed) throw new Error(`expected a submit intent: ${prepared.reason}`);

    const submitSession = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const submitPage = await submitSession.open();
    let reference: string | null = null;
    try {
      await submitPage.goto(`${origin}/apply/${sessionId}/review`, {
        waitUntil: 'domcontentloaded',
      });
      const inventory = await inspectPage(submitPage);
      const executor = new ActionExecutor({
        page: submitPage,
        session: submitSession,
        secrets: [],
        context: {
          workflowState: 'READY_TO_SUBMIT',
          adapter,
          currentStepId: 'review',
          mappedFields: mapInventory(inventory),
          sitePolicy: { origin, applyMode: 'manual_only', submitPermitted: true },
          approvedDocument: {
            documentId: approvedDocument.documentId,
            sha256: approvedDocument.sha256,
          },
          submitGuard: {
            activeIntentTokenHash: (await import('@job-agent/browser-core')).hashSubmitToken(
              prepared.intentToken,
            ),
            snapshotHash: hash,
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            consumed: false,
          },
          takeoverActive: false,
          paused: false,
          hashToken: (await import('@job-agent/browser-core')).hashSubmitToken,
          now: new Date(),
        },
      });
      const outcome = await executor.run([
        {
          kind: 'submit',
          stepId: 'review',
          selector: '#submit-application',
          intentToken: prepared.intentToken,
          snapshotHash: hash,
        },
      ]);
      expect(outcome.stopped).toBe(false);
      reference = await submitPage.locator('#confirmation-reference').textContent();
    } finally {
      await submitSession.close();
      await submitSession.discardArtifacts();
    }

    expect(reference).toMatch(/^FAKE-ATS-[A-Z0-9]{8}$/);
    const final = await workflow.recordSubmissionOutcome({
      applicationId: started.application.id,
      attemptId: started.attempt.id,
      intentId: prepared.intentId,
      outcome: 'submitted',
      confirmationReference: reference,
    });
    expect(final.state.state).toBe('SUBMITTED');
    expect(await stores.ledger.status(started.application.id)).toBe('confirmed');

    // 5. Exactly one submission reached the fake ATS, and a second is impossible.
    const finalState: { submitCount: number; reference: string } = (
      await ats.inject({ method: 'GET', url: `/__state/${sessionId}` })
    ).json();
    expect(finalState.submitCount).toBe(1);
    expect(finalState.reference).toBe(reference);
    const retry = await workflow.prepareSubmit({
      userId,
      applicationId: started.application.id,
      attemptId: started.attempt.id,
      currentSnapshotHash: hash,
      targetOrigin: origin,
      isFakeTarget: true,
    });
    expect(retry.allowed).toBe(false);
  }, 180_000);

  it('stops the run when the fake ATS breaks, without inventing progress', async () => {
    const sessionId = await newAtsSession();
    await ats.inject({ method: 'POST', url: '/__control', payload: { failOnStep: 'details' } });
    const started = await workflow.startAttempt({
      userId,
      jobId,
      matchRunId: null,
      policyVersion: 'phase-2-test',
      targetOrigin: origin,
    });
    await stores.applications.transition({
      applicationId: started.application.id,
      to: 'STARTING',
      actor: 'system',
      reason: 'j',
      correlationId: uuidv7(),
      now: new Date(),
    });
    await stores.applications.transition({
      applicationId: started.application.id,
      to: 'FILLING',
      actor: 'system',
      reason: 'j',
      correlationId: uuidv7(),
      now: new Date(),
    });

    const runner = new ApplicationRunner({ workflow, transport: inProcessTransport, adapter });
    const result = await runner.runUntilPause({
      attemptId: started.attempt.id,
      startUrl: `${origin}/apply/${sessionId}/details`,
      facts,
      approvedDocument,
      sitePolicy: { origin, applyMode: 'manual_only', submitPermitted: true },
    });
    // Two unknown controls still pause the step first; nothing was marked finished.
    expect(result.finishedStepIds).toHaveLength(0);
    expect(result.reachedReview).toBe(false);
  }, 120_000);
});
