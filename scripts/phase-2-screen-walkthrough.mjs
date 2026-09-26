// Drives one practice application against the bundled fake ATS in a THROWAWAY database, so the
// local screens at /applications can be used for the Phase 2 human sign-off.
//
// Why this exists
// ---------------
// `ApplicationRunner` is not wired into `apps/api`, and no HTTP route creates an application. The
// screens can therefore display, approve, reject and resume a practice application, but nothing can
// start or advance one. This script supplies exactly that missing drive. It adds no production
// route, no scheduler hook and no submission capability to the running service.
//
// Safety
// ------
// - It refuses to run against the real local database. A throwaway WALKTHROUGH_DATA_DIR is required.
// - The applicant is invented. No real profile, CV, vacancy or employer is read or contacted.
// - The target must be a loopback fake-ATS origin; anything else aborts.
// - It never prints an answer value, a token or anything from .env.
//
// Usage (the API must be stopped while a stage runs: PGlite is single-writer)
//   WALKTHROUGH_DATA_DIR=./local-data/phase2-screens/pglite \n//     node --env-file=.env scripts/phase-2-screen-walkthrough.mjs <stage>
//
// Stages, in order:
//   seed       create the throwaway database and pause with unknown fields open
//   advance    carry on after you answered the open questions on the screen
//   resume     resume after you completed the human-only steps yourself
//   review     build the review manifest so the screen can show it
//   submit     make the one practice submission, then prove a second is refused
//   stale      change an answer after approval, to invalidate it
//   ambiguous  a separate run whose submission outcome is unclear
//   status     print where the application currently is

import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import { fakeAtsAdapter } from '../packages/adapters/dist/index.js';
import { ApplicationWorkflowService } from '../packages/application/dist/index.js';
import { hashSubmitToken, mapInventory } from '../packages/browser-core/dist/index.js';
import { createApplicationStores, PGliteDatabase } from '../packages/db/dist/index.js';
import { ApplicationRunner } from '../packages/orchestrator/dist/index.js';
import { FieldCipher, StaticEncryptionKeyProvider } from '../packages/security/dist/index.js';
import { ActionExecutor } from '../apps/browser-worker/dist/executor.js';
import { inspectPage } from '../apps/browser-worker/dist/inspector.js';
import { workerRequestSchema } from '../apps/browser-worker/dist/protocol.js';
import { runWorkerRequest } from '../apps/browser-worker/dist/run.js';
import { WorkerSession } from '../apps/browser-worker/dist/session.js';

const requireFromWorker = createRequire(
  new URL('../apps/browser-worker/package.json', import.meta.url),
);
const { chromium } = requireFromWorker('playwright');

const say = (text = '') => console.log(text);
const bullet = (text) => console.log(`  - ${text}`);
const rule = () => console.log('='.repeat(78));
const heading = (text) => {
  say();
  rule();
  say(text);
  rule();
};

const die = (message) => {
  console.error(`\nSTOPPED: ${message}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------

const stage = process.argv[2];
const stages = ['seed', 'advance', 'resume', 'review', 'submit', 'stale', 'ambiguous', 'status'];
if (stage === undefined || !stages.includes(stage)) {
  die(`Choose a stage: ${stages.join(', ')}`);
}

// Deliberately its own variable, not PGLITE_DATA_DIR, so loading .env can never point this at the
// real database by accident.
const REAL_DATA_DIRS = ['./local-data/pglite', 'local-data/pglite'];
const dataDir = process.env.WALKTHROUGH_DATA_DIR;
if (dataDir === undefined || dataDir.trim() === '') {
  die('Set WALKTHROUGH_DATA_DIR to a throwaway directory before running this.');
}
const normalisedDataDir = path.resolve(dataDir).toLowerCase();
for (const forbidden of REAL_DATA_DIRS) {
  if (normalisedDataDir === path.resolve(forbidden).toLowerCase()) {
    die(
      'PGLITE_DATA_DIR points at the real local database. This walkthrough only runs against a throwaway one.',
    );
  }
}

const origin = process.env.FAKE_ATS_ORIGIN ?? 'http://127.0.0.1:3311';
let originUrl;
try {
  originUrl = new URL(origin);
} catch {
  die(`FAKE_ATS_ORIGIN is not a URL: ${origin}`);
}
if (!['127.0.0.1', 'localhost', '::1'].includes(originUrl.hostname)) {
  die('FAKE_ATS_ORIGIN must be a loopback address. This phase never touches a real employer site.');
}

try {
  if (!existsSync(chromium.executablePath())) {
    die('No Chromium for Playwright. Run "pnpm browser:install" once, then try again.');
  }
} catch {
  die('Playwright could not find a browser. Run "pnpm browser:install" once, then try again.');
}

const keyId = process.env.APP_ENCRYPTION_KEY_ID;
const keyBase64 = process.env.APP_ENCRYPTION_KEY_BASE64;
if (!keyId || !keyBase64) {
  die('APP_ENCRYPTION_KEY_ID and APP_ENCRYPTION_KEY_BASE64 must be set. Run with --env-file=.env.');
}

// ---------------------------------------------------------------------------------------------
// The invented applicant. None of this describes a real person.
// ---------------------------------------------------------------------------------------------

const cvBytes = Buffer.from('%PDF-1.4 synthetic screen-walkthrough curriculum vitae');
const approvedDocument = {
  documentId: '33333333-3333-4333-8333-333333333333',
  sha256: createHash('sha256').update(cvBytes).digest('hex'),
  filename: 'synthetic-cv.pdf',
  contentBase64: cvBytes.toString('base64'),
};

/**
 * A stable UUID derived from the fact key, so evidence references are identical every time a stage
 * rebuilds these facts. The worker protocol validates these as UUIDs.
 */
function deterministicUuid(seed) {
  const hex = createHash('sha256').update(seed).digest('hex');
  const version = `5${hex.slice(13, 16)}`;
  const variant = `${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}-${hex.slice(20, 32)}`;
}

const fact = (key, value) => ({
  id: deterministicUuid(`fact:${key}`),
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
  fact('identity.first_name', 'Alex'),
  fact('identity.last_name', 'Sample'),
  fact('contact.email', 'alex.sample@example.invalid'),
  fact('contact.phone', '07700900001'),
  fact('experience.years_total', 6),
  fact('preferences.contract_type', ['Permanent']),
  fact('work_authorisation.gb', { authorised: true }),
  fact('preferences.relocation', 'No'),
  fact(
    'statement.supporting',
    'An invented supporting statement written only for this local walkthrough, long enough to satisfy the minimum length rule.',
  ),
  fact('employment.current_employer', 'Fictional Services Ltd'),
  fact('employment.current_title', 'Information Governance Officer'),
  fact('employment.current_start_date', '2020-01-01'),
  fact('employment.current_end_date', '2026-01-01'),
  fact('employment.current_duties', 'Invented records management and policy duties.'),
  fact('education.institution', 'Invented College'),
  fact('education.qualification', 'Invented Diploma'),
  fact('education.grade', 'Pass'),
  fact('education.year', '2015'),
];

// ---------------------------------------------------------------------------------------------
// State shared between stages
// ---------------------------------------------------------------------------------------------

const stateFile = path.join(path.dirname(path.resolve(dataDir)), 'screen-walkthrough-state.json');

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

async function writeState(state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

async function applyMigrations(database) {
  const directory = path.resolve(process.cwd(), 'migrations');
  const filenames = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  await database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  for (const filename of filenames) {
    const applied = await database.query(
      'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1) AS exists',
      [filename],
    );
    if (applied.rows[0]?.exists === true) continue;
    await database.exec(await readFile(path.join(directory, filename), 'utf8'));
    await database.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
  }
}

async function connect() {
  const pglite = await PGlite.create(dataDir);
  const database = new PGliteDatabase(pglite);
  const stores = createApplicationStores(database);
  const cipher = new FieldCipher(StaticEncryptionKeyProvider.fromBase64(keyId, keyBase64));
  const adapter = fakeAtsAdapter(origin);
  const workflow = new ApplicationWorkflowService({ stores, cipher, adapter });
  return {
    pglite,
    database,
    stores,
    cipher,
    adapter,
    workflow,
    close: () => pglite.close(),
  };
}

const transport = {
  run: async (request) => {
    const parsed = workerRequestSchema.parse(request);
    const result = await runWorkerRequest(parsed);
    return { ok: true, report: result.report, outcomes: result.outcomes };
  },
};

function runInputFor(state) {
  return {
    attemptId: state.attemptId,
    startUrl: `${origin}/apply/${state.sessionId}/details`,
    facts,
    approvedDocument,
    sitePolicy: { origin, applyMode: 'manual_only', submitPermitted: true },
  };
}

const transition = (stores, applicationId, to, reason) =>
  stores.applications.transition({
    applicationId,
    to,
    actor: 'system',
    reason,
    correlationId: randomUUID(),
    now: new Date(),
  });

async function startAtsSession() {
  const response = await fetch(`${origin}/apply/JOB-SCREEN-WALKTHROUGH/start`, {
    method: 'POST',
    redirect: 'manual',
  });
  const location = response.headers.get('location');
  if (location === null) {
    die(`The fake ATS did not start a session. Is "pnpm fake-ats" running on ${origin}?`);
  }
  return String(location).split('/')[2];
}

async function reportOpenQuestions(stores, applicationId) {
  const open = await stores.questions.listOpen(applicationId);
  if (open.length === 0) {
    say('No questions are open.');
    return open;
  }
  say('Questions waiting for you (these appear on the screen):');
  for (const question of open) {
    bullet(`${question.fieldKey} — ${question.reason}`);
  }
  return open;
}

async function reportState(stores, applicationId) {
  const application = await stores.applications.get(applicationId);
  const attempt = await stores.attempts.current(applicationId);
  say(`Application state: ${application?.state ?? 'unknown'}`);
  say(`Attempt status:    ${attempt?.status ?? 'unknown'}`);
  return { application, attempt };
}

// ---------------------------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------------------------

async function seed() {
  // PGlite will not create nested parents for its own data directory.
  await mkdir(path.resolve(dataDir), { recursive: true });
  const pglite = await PGlite.create(dataDir);
  await applyMigrations(pglite);
  await pglite.close();

  const context = await connect();
  try {
    const userId = randomUUID();
    const jobId = randomUUID();
    const companyId = randomUUID();
    await context.database.query(
      `INSERT INTO users (id, timezone, status) VALUES ($1, 'Europe/London', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [userId],
    );
    await context.database.query(
      `INSERT INTO companies (id, canonical_name) VALUES ($1, 'Invented Council')
       ON CONFLICT (id) DO NOTHING`,
      [companyId],
    );
    await context.database.query(
      `INSERT INTO jobs (
         id, company_id, canonical_url, title, description, location_json, content_hash,
         fingerprint, version, status
       ) VALUES ($1, $2, $3, 'Information Governance Officer',
         'Synthetic advert for a job that does not exist.', '{"text":"Glasgow"}'::jsonb, $4, $5, 1,
         'open')`,
      [jobId, companyId, `https://example.invalid/jobs/${jobId}`, 'a'.repeat(64), 'b'.repeat(64)],
    );

    const sessionId = await startAtsSession();
    const started = await context.workflow.startAttempt({
      userId,
      jobId,
      matchRunId: null,
      policyVersion: 'phase-2-screen-walkthrough',
      targetOrigin: origin,
    });
    const applicationId = started.application.id;
    const attemptId = started.attempt.id;
    await transition(context.stores, applicationId, 'STARTING', 'screen walkthrough');
    await transition(context.stores, applicationId, 'FILLING', 'screen walkthrough');

    const state = { userId, jobId, applicationId, attemptId, sessionId, origin };
    await writeState(state);

    const runner = new ApplicationRunner({
      workflow: context.workflow,
      transport,
      adapter: context.adapter,
    });

    heading('STAGE 1. The agent fills only what it can evidence, then stops');
    const result = await runner.runUntilPause(runInputFor(state));
    say(`It stopped on the "${result.pausedAt}" step. Reason: ${result.pauseReason}.`);
    say();
    await reportOpenQuestions(context.stores, applicationId);
    say();
    const filled = await context.stores.fields.list(attemptId);
    say('What it filled, and on what basis (no values are printed):');
    for (const field of filled) {
      const basis =
        field.evidenceFactIds.length > 0
          ? `verified fact (${String(field.evidenceFactIds.length)} evidence reference)`
          : (field.source ?? 'not filled yet — waiting on you');
      bullet(`${field.fieldKey.padEnd(24)} <- ${basis}`);
    }
    say();
    await reportState(context.stores, applicationId);

    heading('Now use the screen');
    say('1. Start the agent again:   pnpm api');
    say('   (with PGLITE_DATA_DIR pointing at this throwaway database)');
    say('2. Open  http://127.0.0.1:3210/applications');
    say('3. Enter your admin token from .env, and this profile ID:');
    say();
    say(`     ${userId}`);
    say();
    say('4. Choose "Show my practice applications". You should see one, with the open questions.');
    say('5. Answer both unknown questions on the screen.');
    say('6. Stop the agent, then run the "advance" stage.');
  } finally {
    await context.close();
  }
}

async function advance() {
  const state = await readState();
  if (state === null) die('No walkthrough state found. Run the "seed" stage first.');
  if (state.humanStepsDone === true) {
    die(
      'The human-only step is already done and the run was resumed. Running "advance" again would ' +
        'ask the agent to re-plan that step, which re-opens those questions. Run "review" instead.',
    );
  }
  const context = await connect();
  try {
    const runner = new ApplicationRunner({
      workflow: context.workflow,
      transport,
      adapter: context.adapter,
    });
    heading('STAGE 2. Carrying on with the answers you gave');
    const result = await runner.runUntilPause(runInputFor(state));
    say(`It stopped on the "${result.pausedAt}" step. Reason: ${result.pauseReason}.`);
    say();
    const open = await reportOpenQuestions(context.stores, state.applicationId);
    say();
    await reportState(context.stores, state.applicationId);

    if (result.pauseReason === 'human_only_step') {
      heading('These are the steps the agent is not allowed to touch');
      say('Complete them yourself, in your own browser, at:');
      say();
      for (const name of ['questions', 'checks', 'declarations']) {
        say(`     ${origin}/apply/${state.sessionId}/${name}`);
      }
      say();
      say('Those pages hold the equal-opportunities questions, the simulated CAPTCHA, the');
      say('one-time code, the assessment confirmation, the declaration and the consent tick.');
      say('The agent never fills any of them, and there is no setting that makes it.');
      say();
      say('On the applications screen, for each of these:');
      say('  1. choose "I will take over"');
      say('  2. complete the page yourself at the address above');
      say('  3. choose "I completed this myself"');
      say();
      say('The confirmation records only that you dealt with it. No value is stored, so the');
      say('agent never learns what you entered. It will refuse to resume until each one is');
      say('confirmed, and it refuses the confirmation itself until you have taken over.');
      say();
      say('When every one is confirmed, run the "resume" stage.');
    } else if (open.length > 0) {
      say();
      say('Answer the remaining questions on the screen, then run "advance" again.');
    }
  } finally {
    await context.close();
  }
}

async function resume() {
  const state = await readState();
  if (state === null) die('No walkthrough state found. Run the "seed" stage first.');
  const context = await connect();
  try {
    heading('STAGE 3. Resuming after the steps only you may do');
    const open = await context.stores.questions.listOpen(state.applicationId);
    if (open.length > 0) {
      say('It will not resume while a question is still open. Still waiting on:');
      for (const question of open) bullet(question.fieldKey);
      say();
      say('That refusal is the intended behaviour, not a fault.');
      return;
    }
    const result = await context.workflow.resume({ applicationId: state.applicationId });
    say(`Resume accepted: ${String(result.resumed)}. ${result.message}`);
    if (result.resumed) await writeState({ ...state, humanStepsDone: true });
    say();
    await reportState(context.stores, state.applicationId);
    say();
    say('Next: run the "review" stage. Do not run "advance" again — the human-only step is done,');
    say('and re-planning it would simply re-open those questions.');
  } finally {
    await context.close();
  }
}

async function review() {
  const state = await readState();
  if (state === null) die('No walkthrough state found. Run the "seed" stage first.');
  const context = await connect();
  try {
    heading('STAGE 4. The review you approve');
    // Re-runnable: only move the state forward if it has not already reached the review.
    const before = await context.stores.applications.get(state.applicationId);
    if (before?.state !== 'READY_FOR_REVIEW' && before?.state !== 'WAITING_APPROVAL') {
      await transition(
        context.stores,
        state.applicationId,
        'READY_FOR_REVIEW',
        'screen walkthrough',
      );
    }
    const { manifest, hash } = await context.workflow.buildManifest({
      applicationId: state.applicationId,
      attemptId: state.attemptId,
      jobId: state.jobId,
      jobVersion: 1,
      cvDocumentId: approvedDocument.documentId,
      cvSha256: approvedDocument.sha256,
    });
    const afterManifest = await context.stores.applications.get(state.applicationId);
    if (afterManifest?.state !== 'WAITING_APPROVAL') {
      await transition(
        context.stores,
        state.applicationId,
        'WAITING_APPROVAL',
        'awaiting approval',
      );
    }
    await writeState({ ...state, manifestHash: hash });

    say(`Review reference:      ${hash.slice(0, 16)}...`);
    say(`Outstanding questions: ${String(manifest.outstandingQuestions)}`);
    say(`CV attached, by hash:  ${manifest.cvSha256?.slice(0, 16)}...`);
    say(`Adapter:               ${manifest.adapterId} ${manifest.adapterVersion}`);
    say();
    say('Every answer, and where it came from:');
    for (const answer of manifest.answers) {
      const evidence =
        answer.evidenceFactIds.length > 0
          ? `evidence: ${String(answer.evidenceFactIds.length)} fact reference`
          : answer.source === 'approved_document'
            ? 'your approved CV, by hash'
            : answer.source === 'application_scoped_answer'
              ? 'you answered this, for this application only'
              : answer.source === 'human_only'
                ? 'you completed this yourself; the agent never saw it'
                : `not answered (${answer.source})`;
      say(`  ${answer.fieldKey.padEnd(28)} ${evidence}`);
    }
    say();
    const sensitiveLeak = manifest.answers.filter(
      (answer) => answer.sensitive === true && (answer.answerPreview ?? null) !== null,
    );
    say(
      sensitiveLeak.length === 0
        ? 'No sensitive answer carries a preview in the review.'
        : `PROBLEM: sensitive previews found: ${sensitiveLeak.map((a) => a.fieldKey).join(', ')}`,
    );

    heading('Now use the screen');
    say('1. Start the agent again and open http://127.0.0.1:3210/applications');
    say('2. Open this application and read the review. Check that:');
    bullet('every field you expect is listed');
    bullet('each answer names its evidence, or says you supplied it');
    bullet('the sensitive answers say the agent never saw them');
    bullet('the CV is identified by hash');
    say('3. Choose "Approve these exact answers".');
    say('4. Stop the agent, then run the "submit" stage.');
    say();
    say('To see approval invalidated instead, run the "stale" stage after approving.');
  } finally {
    await context.close();
  }
}

async function stale() {
  const state = await readState();
  if (state === null) die('No walkthrough state found. Run the "seed" stage first.');
  if (state.manifestHash === undefined) die('Run the "review" stage first.');
  const context = await connect();
  try {
    heading('STAGE 5. The form changes after you approved');
    const attempt = await context.stores.attempts.current(state.applicationId);
    const approved = attempt?.answerManifestHash ?? null;
    if (approved === null) {
      say('No approval is on record yet. Approve the review on the screen first, then run this.');
      return;
    }
    say(`You approved review: ${String(approved).slice(0, 16)}...`);
    say();
    say('Now the employer edits the form and adds a required question, which is the real way an');
    say('approval goes stale. The agent re-reads the page and the review no longer matches.');
    say();

    // Read the real page, then add one required control to it, exactly as a form edit would.
    const session = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const page = await session.open();
    let inventory;
    try {
      await page.goto(`${origin}/apply/${state.sessionId}/details`, {
        waitUntil: 'domcontentloaded',
      });
      inventory = await inspectPage(page);
    } finally {
      await session.close();
      await session.discardArtifacts();
    }

    await context.workflow.planStep({
      attemptId: state.attemptId,
      inventory: {
        ...inventory,
        pageFingerprint: createHash('sha256')
          .update(`${inventory.pageFingerprint}:late-addition`)
          .digest('hex'),
        fields: [
          ...inventory.fields,
          {
            fieldKey: 'late_addition',
            label: 'A question the employer added after you started',
            controlType: 'checkbox',
            selector: '[name="late_addition"]',
            required: true,
            options: [],
          },
        ],
      },
      facts,
      approvedDocument,
    });

    const rebuilt = await context.workflow.buildManifest({
      applicationId: state.applicationId,
      attemptId: state.attemptId,
      jobId: state.jobId,
      jobVersion: 1,
      cvDocumentId: approvedDocument.documentId,
      cvSha256: approvedDocument.sha256,
    });
    say(`The review is now: ${rebuilt.hash.slice(0, 16)}...`);
    say(
      rebuilt.hash === approved
        ? 'PROBLEM: the review reference did not change after a material change to the form.'
        : 'The review reference changed, so the approval you gave no longer matches it.',
    );

    const blocked = await context.workflow.prepareSubmit({
      userId: state.userId,
      applicationId: state.applicationId,
      attemptId: state.attemptId,
      currentSnapshotHash: rebuilt.hash,
      targetOrigin: origin,
      isFakeTarget: true,
    });
    say(
      blocked.allowed
        ? 'PROBLEM: it would still submit after a material change.'
        : `A submission is refused: ${blocked.reason}`,
    );
    await writeState({ ...state, manifestHash: rebuilt.hash, staleDemonstrated: true });
    say();
    say('On the screen the approval is no longer valid and you are asked to look again. Re-read');
    say('the review, approve it afresh, then run the "submit" stage.');
  } finally {
    await context.close();
  }
}

async function submitOnce({ label, expectAmbiguous = false }) {
  const state = await readState();
  if (state === null) die('No walkthrough state found. Run the "seed" stage first.');
  const context = await connect();
  try {
    heading(label);
    const attempt = await context.stores.attempts.current(state.applicationId);
    const approvedHash = attempt?.answerManifestHash ?? null;
    if (approvedHash === null) {
      say('No approval is on record. Approve the review on the screen first.');
      return;
    }
    const prepared = await context.workflow.prepareSubmit({
      userId: state.userId,
      applicationId: state.applicationId,
      attemptId: state.attemptId,
      currentSnapshotHash: approvedHash,
      targetOrigin: origin,
      isFakeTarget: true,
    });
    if (!prepared.allowed) {
      say(`It refused to prepare a submission: ${prepared.reason}`);
      return;
    }

    const session = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const page = await session.open();
    let reference = null;
    let stopped = null;
    try {
      await page.goto(`${origin}/apply/${state.sessionId}/review`, {
        waitUntil: 'domcontentloaded',
      });
      const inventory = await inspectPage(page);
      const executor = new ActionExecutor({
        page,
        session,
        secrets: [],
        context: {
          adapter: context.adapter,
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
            snapshotHash: approvedHash,
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
          snapshotHash: approvedHash,
        },
      ]);
      stopped = result.stopped;
      reference = await page
        .locator('#confirmation-reference')
        .textContent()
        .catch(() => null);
    } finally {
      await session.close();
      await session.discardArtifacts();
    }

    say(`Submission stopped early: ${String(stopped)}`);
    say(`Confirmation reference:   ${reference ?? '(none returned)'}`);
    await context.workflow.recordSubmissionOutcome({
      applicationId: state.applicationId,
      attemptId: state.attemptId,
      intentId: prepared.intentId,
      outcome: reference === null ? 'unknown' : 'submitted',
      confirmationReference: reference,
    });
    await reportState(context.stores, state.applicationId);

    const second = await context.workflow.prepareSubmit({
      userId: state.userId,
      applicationId: state.applicationId,
      attemptId: state.attemptId,
      currentSnapshotHash: approvedHash,
      targetOrigin: origin,
      isFakeTarget: true,
    });
    say(
      second.allowed
        ? 'PROBLEM: a second submission was allowed.'
        : `A second submission is refused: ${second.reason}`,
    );

    const atsState = await (await fetch(`${origin}/__state/${state.sessionId}`)).json();
    say(`Times the fake site recorded a submission: ${String(atsState.submitCount ?? 'unknown')}`);
    if (expectAmbiguous) {
      say();
      say('An unclear outcome waits for you. It never retries by itself, because a retry could');
      say('create a second application.');
    }
  } finally {
    await context.close();
  }
}

async function status() {
  const state = await readState();
  if (state === null) die('No walkthrough state found. Run the "seed" stage first.');
  const context = await connect();
  try {
    heading('Where the practice application currently is');
    say(`Profile ID:     ${state.userId}`);
    say(`Application ID: ${state.applicationId}`);
    say();
    await reportState(context.stores, state.applicationId);
    say();
    await reportOpenQuestions(context.stores, state.applicationId);
    const attempt = await context.stores.attempts.current(state.applicationId);
    say();
    say(
      `Approval on record: ${
        attempt?.answerManifestHash === null || attempt?.answerManifestHash === undefined
          ? 'none'
          : `${String(attempt.answerManifestHash).slice(0, 16)}...`
      }`,
    );
  } finally {
    await context.close();
  }
}

async function ambiguous() {
  heading('STAGE 6. A submission whose outcome is unclear');
  const response = await fetch(`${origin}/__control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ submitOutcome: 'ambiguous' }),
  });
  say(`Fake site set to return no confirmation: HTTP ${String(response.status)}`);
  say();
  say('This changes the fake site only. Run "seed" through "submit" again to watch an');
  say('application go to reconciliation instead of confirming, then reset the site with:');
  say(`  curl -X POST ${origin}/__control -H "content-type: application/json" -d "{}"`);
}

// ---------------------------------------------------------------------------------------------

say('Phase 2 screen walkthrough');
say();
say(`Practice job site: ${origin}   (loopback only)`);
say(`Throwaway database: ${dataDir}`);
say('Employer involved: none. This is the bundled fake ATS.');
say('Applicant data:    invented. No real profile, CV or vacancy is read.');

if (stage === 'seed') await seed();
else if (stage === 'advance') await advance();
else if (stage === 'resume') await resume();
else if (stage === 'review') await review();
else if (stage === 'stale') await stale();
else if (stage === 'submit') await submitOnce({ label: 'STAGE 6. One practice submission only' });
else if (stage === 'ambiguous') await ambiguous();
else if (stage === 'status') await status();

say();
say('Nothing was sent to any employer.');
