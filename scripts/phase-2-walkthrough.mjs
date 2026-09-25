// Drives one complete practice application against the bundled fake ATS and narrates every step.
//
// Everything here is local and synthetic. It starts its own fake job site on the loopback
// interface, uses a throwaway in-memory database, and invents an applicant who does not exist.
// It touches no real vacancy site, no real profile and no real CV, and it cannot reach anything
// outside 127.0.0.1.
//
// Run it with:  pnpm walkthrough:phase2
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// Playwright belongs to the browser worker, so resolve it from there rather than the repo root.
const requireFromWorker = createRequire(
  new URL('../apps/browser-worker/package.json', import.meta.url),
);
const { chromium } = requireFromWorker('playwright');

import { fakeAtsAdapter } from '../packages/adapters/dist/index.js';
import { ApplicationWorkflowService } from '../packages/application/dist/index.js';
import { createApplicationStores, createMigratedTestDatabase } from '../packages/db/dist/index.js';
import { hashSubmitToken, mapInventory } from '../packages/browser-core/dist/index.js';
import { buildFakeAts } from '../apps/fake-ats/dist/index.js';
import { ApplicationRunner } from '../packages/orchestrator/dist/index.js';
import { FieldCipher, StaticEncryptionKeyProvider } from '../packages/security/dist/index.js';
import { ActionExecutor } from '../apps/browser-worker/dist/executor.js';
import { inspectPage } from '../apps/browser-worker/dist/inspector.js';
import { workerRequestSchema } from '../apps/browser-worker/dist/protocol.js';
import { runWorkerRequest } from '../apps/browser-worker/dist/run.js';
import { WorkerSession } from '../apps/browser-worker/dist/session.js';
import { v7 as uuidv7 } from 'uuid';

let step = 0;
const say = (text) => console.log(text);
const heading = (text) => {
  step += 1;
  console.log(`\n${'='.repeat(78)}\nSTEP ${step}. ${text}\n${'='.repeat(78)}`);
};
const bullet = (text) => console.log(`  - ${text}`);

try {
  if (!existsSync(chromium.executablePath())) {
    say('No Chromium is installed for Playwright on this machine.');
    say('Run "pnpm browser:install" once, then run this again.');
    process.exit(1);
  }
} catch {
  say('Playwright could not find a browser. Run "pnpm browser:install" once, then try again.');
  process.exit(1);
}

const cvBytes = Buffer.from('%PDF-1.4 synthetic walkthrough curriculum vitae');
const approvedDocument = {
  documentId: '22222222-2222-4222-8222-222222222222',
  sha256: createHash('sha256').update(cvBytes).digest('hex'),
  filename: 'synthetic-cv.pdf',
  contentBase64: cvBytes.toString('base64'),
};

const fact = (key, value) => ({
  id: uuidv7(),
  key,
  value,
  status: 'verified',
  source: 'user',
  sensitivity: 'normal',
  usePolicy: 'auto_fill',
  allowedPurposes: ['matching', 'application'],
  version: 1,
});

const facts = [
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
    'A synthetic supporting statement written only for this local walkthrough, long enough to satisfy the minimum length rule.',
  ),
  fact('employment.current_employer', 'Example Synthetic Ltd'),
  fact('employment.current_title', 'Governance Officer'),
  fact('employment.current_start_date', '2020-01-01'),
  fact('employment.current_end_date', '2026-01-01'),
  fact('employment.current_duties', 'Synthetic duties recorded for this walkthrough.'),
  fact('education.institution', 'Example Synthetic College'),
  fact('education.qualification', 'Synthetic Diploma'),
  fact('education.grade', 'Pass'),
  fact('education.year', '2015'),
];

const ats = buildFakeAts();
await ats.listen({ host: '127.0.0.1', port: 0 });
const address = ats.server.address();
const origin = `http://127.0.0.1:${String(address.port)}`;
const adapter = fakeAtsAdapter(origin);

const database = await createMigratedTestDatabase();
const stores = createApplicationStores(database.db);
const cipher = new FieldCipher(
  new StaticEncryptionKeyProvider('walkthrough-v1', new Map([['walkthrough-v1', randomBytes(32)]])),
);
const workflow = new ApplicationWorkflowService({ stores, cipher, adapter });

const userId = uuidv7();
const jobId = uuidv7();
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
  [jobId, companyId, `https://example.invalid/jobs/${jobId}`, 'c'.repeat(64), 'd'.repeat(64)],
);

const transport = {
  run: async (request) => {
    const parsed = workerRequestSchema.parse(request);
    const result = await runWorkerRequest(parsed);
    return { ok: true, report: result.report, outcomes: result.outcomes };
  },
};

const answerOpen = async (applicationId, attemptId, value) => {
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
  return open;
};

const transition = (applicationId, to, reason) =>
  stores.applications.transition({
    applicationId,
    to,
    actor: 'system',
    reason,
    correlationId: uuidv7(),
    now: new Date(),
  });

say('Practice application walkthrough');
say('');
say(`Practice job site: ${origin}   (loopback only, started by this script)`);
say('Employer involved: none. This is the bundled fake ATS.');
say('Applicant data:    synthetic. No real profile or CV is read.');

const startResponse = await ats.inject({ method: 'POST', url: '/apply/JOB-WALKTHROUGH/start' });
const sessionId = String(startResponse.headers.location).split('/')[2];

const started = await workflow.startAttempt({
  userId,
  jobId,
  matchRunId: null,
  policyVersion: 'phase-2-walkthrough',
  targetOrigin: origin,
});
const applicationId = started.application.id;
const attemptId = started.attempt.id;
await transition(applicationId, 'STARTING', 'walkthrough');
await transition(applicationId, 'FILLING', 'walkthrough');

const runner = new ApplicationRunner({ workflow, transport, adapter });
const runInput = {
  attemptId,
  startUrl: `${origin}/apply/${sessionId}/details`,
  facts,
  approvedDocument,
  sitePolicy: { origin, applyMode: 'manual_only', submitPermitted: true },
};

heading('The agent opens the form and fills only what it can evidence');
const first = await runner.runUntilPause(runInput);
say(`It stopped on the "${first.pausedAt}" step. Reason: ${first.pauseReason}.`);
const firstQuestions = await stores.questions.listOpen(applicationId);
say('');
say('Questions it will not answer by itself:');
for (const question of firstQuestions) {
  bullet(`${question.fieldKey} (${question.reason.replace(/_/g, ' ')}) — ${question.prompt}`);
}
const filledSoFar = await stores.fields.list(attemptId);
say('');
say('What it did fill, and on what evidence:');
for (const field of filledSoFar.filter((row) => row.answerSource === 'verified_fact')) {
  bullet(`${field.fieldKey} <- verified fact (${field.evidenceFactIds.length} evidence reference)`);
}

heading('You answer the questions, and it carries on');
const answered = await answerOpen(applicationId, attemptId, 'Blue');
say(`Answered ${String(answered.length)} question(s), stored for this application only.`);
await transition(applicationId, 'FILLING', 'answered');
const second = await runner.runUntilPause(runInput);
say(`Steps completed: ${second.finishedStepIds.join(', ')}`);
say(`It stopped again on "${second.pausedAt}". Reason: ${second.pauseReason}.`);
const sensitive = await stores.questions.listOpen(applicationId);
say('');
say('These are the ones it is not allowed to answer at all:');
for (const question of sensitive) {
  bullet(`${question.fieldKey} (${question.reason.replace(/_/g, ' ')})`);
}
const application = await stores.applications.get(applicationId);
say('');
say(`Application state: ${application.state}. It is waiting for you, not retrying.`);

heading('Checking what actually reached the form');
const atsState = (await ats.inject({ method: 'GET', url: `/__state/${sessionId}` })).json();
say(`CV uploaded: ${atsState.files.cv?.filename ?? 'none'}`);
const supplied = new Set(
  facts.flatMap((entry) => {
    const value = entry.value;
    if (typeof value === 'string') return [value];
    if (typeof value === 'number') return [String(value)];
    if (Array.isArray(value)) return value.map(String);
    return [];
  }),
);
supplied.add('Blue');
supplied.add('Yes');
supplied.add('No');
const unexplained = Object.entries(atsState.values).filter(
  ([, value]) => value.trim() !== '' && !supplied.has(value),
);
say(
  unexplained.length === 0
    ? 'Every value on the form traces back to a verified fact or to an answer you gave. Nothing was invented.'
    : `UNEXPLAINED VALUES FOUND: ${JSON.stringify(unexplained)}`,
);

heading('You take over for the parts only a person may do');
await workflow.requestTakeover({ applicationId });
await answerOpen(applicationId, attemptId, 'Prefer not to say');
say('Agent stopped. Completing the sensitive, declaration and consent steps as the user would.');
const humanSession = new WorkerSession({ targetOrigin: origin, secrets: [] });
const humanPage = await humanSession.open();
try {
  for (const name of ['questions', 'checks', 'declarations']) {
    await humanPage.goto(`${origin}/apply/${sessionId}/${name}`, { waitUntil: 'domcontentloaded' });
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
    bullet(`${name} completed by the user`);
  }
  say(`The browser is now on: ${humanPage.url().replace(origin, '')}`);
} finally {
  await humanSession.close();
  await humanSession.discardArtifacts();
}
const resumed = await workflow.resume({ applicationId });
say(`Resume accepted: ${String(resumed.resumed)}. ${resumed.message}`);

heading('The review you approve');
await transition(applicationId, 'READY_FOR_REVIEW', 'review');
const { manifest, hash } = await workflow.buildManifest({
  applicationId,
  attemptId,
  jobId,
  jobVersion: 1,
  cvDocumentId: approvedDocument.documentId,
  cvSha256: approvedDocument.sha256,
});
say(`Review reference: ${hash.slice(0, 16)}...`);
say(`Outstanding questions: ${String(manifest.outstandingQuestions)}`);
say(`CV attached, by hash:  ${manifest.cvSha256?.slice(0, 16)}...`);
say(`Adapter version:       ${manifest.adapterId} ${manifest.adapterVersion}`);
say('');
say('Every answer, and where it came from:');
for (const answer of manifest.answers) {
  const evidence =
    answer.source === 'verified_fact'
      ? `evidence: ${String(answer.evidenceFactIds.length)} fact reference`
      : answer.source === 'application_scoped_answer'
        ? 'you answered this'
        : answer.source === 'human_only'
          ? 'you completed this; the agent never saw it'
          : answer.source;
  bullet(`${answer.fieldKey.padEnd(26)} ${evidence}`);
}
const leaked = manifest.answers.filter(
  (answer) => answer.sensitive && (answer.answerPreview !== null || answer.answerHash !== null),
);
say('');
say(
  leaked.length === 0
    ? 'No sensitive answer carries a preview or a hash in the review.'
    : `SENSITIVE DATA IN REVIEW: ${JSON.stringify(leaked)}`,
);

heading('Approval is bound to that exact review');
await transition(applicationId, 'WAITING_APPROVAL', 'awaiting approval');
await workflow.recordDecision({
  applicationId,
  attemptId,
  snapshotHash: hash,
  decision: 'approved',
  reason: null,
});
say(`Approved review ${hash.slice(0, 16)}...`);
const staleAttempt = await workflow.prepareSubmit({
  userId,
  applicationId,
  attemptId,
  currentSnapshotHash: 'f'.repeat(64),
  targetOrigin: origin,
  isFakeTarget: true,
});
say(
  staleAttempt.allowed
    ? 'PROBLEM: a changed review was still allowed to submit.'
    : `A changed review is refused: ${staleAttempt.reason}`,
);

heading('One practice submission, and only one');
const prepared = await workflow.prepareSubmit({
  userId,
  applicationId,
  attemptId,
  currentSnapshotHash: hash,
  targetOrigin: origin,
  isFakeTarget: true,
});
if (!prepared.allowed) throw new Error(`expected a submit intent: ${prepared.reason}`);
const submitSession = new WorkerSession({ targetOrigin: origin, secrets: [] });
const submitPage = await submitSession.open();
let reference = null;
try {
  await submitPage.goto(`${origin}/apply/${sessionId}/review`, { waitUntil: 'domcontentloaded' });
  const inventory = await inspectPage(submitPage);
  const executor = new ActionExecutor({
    page: submitPage,
    session: submitSession,
    secrets: [],
    context: {
      adapter,
      workflowState: 'READY_TO_SUBMIT',
      currentStepId: 'review',
      mappedFields: mapInventory(inventory),
      sitePolicy: { origin, applyMode: 'manual_only', submitPermitted: true },
      approvedDocument: {
        documentId: approvedDocument.documentId,
        sha256: approvedDocument.sha256,
      },
      submitGuard: {
        activeIntentTokenHash: hashSubmitToken(prepared.intentToken),
        snapshotHash: hash,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        consumed: false,
      },
      takeoverActive: false,
      paused: false,
      hashToken: hashSubmitToken,
      now: new Date(),
    },
  });
  const result = await executor.run([
    {
      kind: 'submit',
      stepId: 'review',
      selector: '#submit-application',
      intentToken: prepared.intentToken,
      snapshotHash: hash,
    },
  ]);
  reference = await submitPage.locator('#confirmation-reference').textContent();
  say(`Submission stopped early: ${String(result.stopped)}`);
} finally {
  await submitSession.close();
  await submitSession.discardArtifacts();
}
say(`Fake confirmation reference: ${reference ?? 'none captured'}`);

const final = await workflow.recordSubmissionOutcome({
  applicationId,
  attemptId,
  intentId: prepared.intentId,
  outcome: 'submitted',
  confirmationReference: reference,
});
say(`Application state: ${final.state.state}`);
say(`Submission ledger:  ${await stores.ledger.status(applicationId)}`);
const again = await workflow.prepareSubmit({
  userId,
  applicationId,
  attemptId,
  currentSnapshotHash: hash,
  targetOrigin: origin,
  isFakeTarget: true,
});
say(
  again.allowed
    ? 'PROBLEM: a second submission was allowed.'
    : `A second submission is refused: ${again.reason}`,
);
const finalState = (await ats.inject({ method: 'GET', url: `/__state/${sessionId}` })).json();
say(`Times the fake site recorded a submission: ${String(finalState.submitCount)}`);
say(`Reference the fake site holds:             ${String(finalState.reference)}`);

// ---------------------------------------------------------------------------------------------
// The two awkward cases the Phase 2 gate asks you to rehearse.
// ---------------------------------------------------------------------------------------------

heading('Rehearsal: the form rejects the first attempt');
await ats.inject({
  method: 'POST',
  url: '/__control',
  payload: { validationOnFirstAttempt: true },
});
const vSession = String(
  (await ats.inject({ method: 'POST', url: '/apply/JOB-VALIDATION/start' })).headers.location,
).split('/')[2];
const vJobId = uuidv7();
await database.db.query(
  `INSERT INTO jobs (
     id, company_id, canonical_url, title, description, location_json, content_hash, fingerprint,
     version, status
   ) VALUES ($1, $2, $3, 'Records Officer', 'Synthetic advert.',
     '{"text":"Glasgow"}'::jsonb, $4, $5, 1, 'open')`,
  [vJobId, companyId, `https://example.invalid/jobs/${vJobId}`, 'e'.repeat(64), 'f'.repeat(64)],
);
const vStarted = await workflow.startAttempt({
  userId,
  jobId: vJobId,
  matchRunId: null,
  policyVersion: 'phase-2-walkthrough',
  targetOrigin: origin,
});
await transition(vStarted.application.id, 'STARTING', 'validation rehearsal');
await transition(vStarted.application.id, 'FILLING', 'validation rehearsal');
const vInput = {
  attemptId: vStarted.attempt.id,
  startUrl: `${origin}/apply/${vSession}/details`,
  facts,
  approvedDocument,
  sitePolicy: { origin, applyMode: 'manual_only', submitPermitted: true },
};
// Clear the unknown-field questions first, so what remains to see is the validation behaviour.
await runner.runUntilPause(vInput);
await answerOpen(vStarted.application.id, vStarted.attempt.id, 'Blue');
await transition(vStarted.application.id, 'FILLING', 'answered');
const vRun = await runner.runUntilPause(vInput);
say('The fake site rejected the first submission of the details step.');
say(`Steps it got through anyway: ${vRun.finishedStepIds.join(', ') || 'none'}`);
say(`It stopped at "${vRun.pausedAt}". Reason: ${vRun.pauseReason}.`);
const vFields = await stores.fields.list(vStarted.attempt.id);
const rejected = vFields.filter((row) => row.validationStatus === 'rejected');
say(
  rejected.length > 0
    ? `It recorded the form's complaint rather than guessing: ${rejected
        .map((row) => `${row.fieldKey} (${row.validationMessage ?? 'no message'})`)
        .join('; ')}`
    : 'It re-read the page and corrected what the evidence supported.',
);
say('It never retries more than three rounds. After that it stops and asks you.');
await ats.inject({ method: 'POST', url: '/__control', payload: { reset: true } });

heading('Rehearsal: the submission outcome is unclear');
const aJobId = uuidv7();
await database.db.query(
  `INSERT INTO jobs (
     id, company_id, canonical_url, title, description, location_json, content_hash, fingerprint,
     version, status
   ) VALUES ($1, $2, $3, 'Compliance Officer', 'Synthetic advert.',
     '{"text":"Glasgow"}'::jsonb, $4, $5, 1, 'open')`,
  [aJobId, companyId, `https://example.invalid/jobs/${aJobId}`, '1'.repeat(64), '2'.repeat(64)],
);
const aStarted = await workflow.startAttempt({
  userId,
  jobId: aJobId,
  matchRunId: null,
  policyVersion: 'phase-2-walkthrough',
  targetOrigin: origin,
});
await transition(aStarted.application.id, 'STARTING', 'ambiguous rehearsal');
await transition(aStarted.application.id, 'FILLING', 'ambiguous rehearsal');
await transition(aStarted.application.id, 'READY_FOR_REVIEW', 'ambiguous rehearsal');
const aReview = await workflow.buildManifest({
  applicationId: aStarted.application.id,
  attemptId: aStarted.attempt.id,
  jobId: aJobId,
  jobVersion: 1,
  cvDocumentId: approvedDocument.documentId,
  cvSha256: approvedDocument.sha256,
});
await transition(aStarted.application.id, 'WAITING_APPROVAL', 'ambiguous rehearsal');
await workflow.recordDecision({
  applicationId: aStarted.application.id,
  attemptId: aStarted.attempt.id,
  snapshotHash: aReview.hash,
  decision: 'approved',
  reason: null,
});
const aPrepared = await workflow.prepareSubmit({
  userId,
  applicationId: aStarted.application.id,
  attemptId: aStarted.attempt.id,
  currentSnapshotHash: aReview.hash,
  targetOrigin: origin,
  isFakeTarget: true,
});
if (!aPrepared.allowed) throw new Error(`expected a submit intent: ${aPrepared.reason}`);
say('The practice submission ran, but the site came back with no confirmation reference.');
const aOutcome = await workflow.recordSubmissionOutcome({
  applicationId: aStarted.application.id,
  attemptId: aStarted.attempt.id,
  intentId: aPrepared.intentId,
  outcome: 'unknown',
  confirmationReference: null,
});
say(`Application state:  ${aOutcome.state.state}`);
say(`Submission ledger:  ${await stores.ledger.status(aStarted.application.id)}`);
const aRetry = await workflow.prepareSubmit({
  userId,
  applicationId: aStarted.application.id,
  attemptId: aStarted.attempt.id,
  currentSnapshotHash: aReview.hash,
  targetOrigin: origin,
  isFakeTarget: true,
});
say(
  aRetry.allowed
    ? 'PROBLEM: it was willing to retry an unclear submission.'
    : `It will not retry by itself: ${aRetry.reason}`,
);
say(
  'An unclear outcome waits for you. A retry could create a second application, so it never guesses.',
);

say('');
say('='.repeat(78));
say('Walkthrough finished. Nothing was sent to any employer.');
say('='.repeat(78));

await ats.close();
await database.close();
