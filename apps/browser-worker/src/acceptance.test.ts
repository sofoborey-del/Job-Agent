import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { buildFakeAts, type FakeAtsApp } from '@job-agent/fake-ats';
import { fakeAtsAdapter } from '@job-agent/adapters';
import {
  hashSubmitToken,
  isLoopbackOrigin,
  mapInventory,
  validateAction,
  type AdapterContract,
  type BrowserAction,
  type FieldInventory,
  type ValidationContext,
} from '@job-agent/browser-core';
import { chromium } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ActionExecutor } from './executor.js';
import { inspectPage } from './inspector.js';
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

const syntheticApplicant = {
  firstName: 'Sam',
  lastName: 'Tester',
  email: 'sam.tester@example.test',
  phone: '07700900000',
  years: '6',
  statement:
    'A synthetic supporting statement written only for the local fake ATS acceptance suite. It contains no real applicant information.',
};

/** Reads the redirect target without a non-null assertion. */
function locationOf(headers: Record<string, unknown>): string {
  const location = headers.location;
  return typeof location === 'string' ? location : '';
}

async function startSession(): Promise<string> {
  const response = await ats.inject({ method: 'POST', url: '/apply/JOB-ACCEPTANCE/start' });
  return locationOf(response.headers).split('/')[2] ?? '';
}

function contextFor(input: {
  inventory: FieldInventory;
  overrides?: Partial<ValidationContext>;
}): ValidationContext {
  return {
    workflowState: 'FILLING',
    adapter,
    currentStepId: input.inventory.stepId,
    mappedFields: mapInventory(input.inventory),
    sitePolicy: { origin, applyMode: 'manual_only', submitPermitted: true },
    approvedDocument: null,
    submitGuard: {
      activeIntentTokenHash: null,
      snapshotHash: null,
      expiresAt: null,
      consumed: false,
    },
    takeoverActive: false,
    paused: false,
    hashToken: hashSubmitToken,
    now: new Date(),
    ...input.overrides,
  };
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
});

suite('fake ATS acceptance suite', () => {
  it('fills every supported control and advances through a step', async () => {
    const sessionId = await startSession();
    const session = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const page = await session.open();
    try {
      await page.goto(`${origin}/apply/${sessionId}/details`, { waitUntil: 'domcontentloaded' });
      const inventory = await inspectPage(page);
      expect(inventory.stepId).toBe('details');
      expect(inventory.fields.map((field) => field.controlType)).toEqual(
        expect.arrayContaining([
          'text',
          'email',
          'tel',
          'number',
          'select',
          'radio',
          'checkbox',
          'textarea',
        ]),
      );

      const evidence = '11111111-1111-4111-8111-111111111111';
      const actions: BrowserAction[] = [
        {
          kind: 'fill',
          stepId: 'details',
          fieldKey: 'first_name',
          selector: '[name="first_name"]',
          value: syntheticApplicant.firstName,
          source: 'verified_fact',
          evidenceFactIds: [evidence],
        },
        {
          kind: 'fill',
          stepId: 'details',
          fieldKey: 'last_name',
          selector: '[name="last_name"]',
          value: syntheticApplicant.lastName,
          source: 'verified_fact',
          evidenceFactIds: [evidence],
        },
        {
          kind: 'fill',
          stepId: 'details',
          fieldKey: 'email',
          selector: '[name="email"]',
          value: syntheticApplicant.email,
          source: 'verified_fact',
          evidenceFactIds: [evidence],
        },
        {
          kind: 'fill',
          stepId: 'details',
          fieldKey: 'phone',
          selector: '[name="phone"]',
          value: syntheticApplicant.phone,
          source: 'verified_fact',
          evidenceFactIds: [evidence],
        },
        {
          kind: 'fill',
          stepId: 'details',
          fieldKey: 'years_experience',
          selector: '[name="years_experience"]',
          value: syntheticApplicant.years,
          source: 'verified_fact',
          evidenceFactIds: [evidence],
        },
        {
          kind: 'select',
          stepId: 'details',
          fieldKey: 'contract_preference',
          selector: '[name="contract_preference"]',
          value: 'Permanent',
          source: 'verified_fact',
          evidenceFactIds: [evidence],
        },
        {
          kind: 'check',
          stepId: 'details',
          fieldKey: 'right_to_work',
          selector: '[name="right_to_work"]',
          checked: true,
          value: 'Yes',
          source: 'verified_fact',
          evidenceFactIds: [evidence],
        },
        {
          kind: 'fill',
          stepId: 'details',
          fieldKey: 'supporting_statement',
          selector: '[name="supporting_statement"]',
          value: syntheticApplicant.statement,
          source: 'verified_fact',
          evidenceFactIds: [evidence],
        },
        { kind: 'click_next', stepId: 'details', selector: '#next' },
      ];
      const executor = new ActionExecutor({
        page,
        session,
        context: contextFor({ inventory }),
        secrets: [syntheticApplicant.firstName, syntheticApplicant.phone],
      });
      const result = await executor.run(actions);
      expect(result.stopped).toBe(false);
      expect(page.url()).toContain('/history');
    } finally {
      await session.close();
      await session.discardArtifacts();
    }
  }, 60_000);

  it('refuses to answer unknown, sensitive and human-only controls', async () => {
    const sessionId = await startSession();
    const session = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const page = await session.open();
    try {
      await page.goto(`${origin}/apply/${sessionId}/details`, { waitUntil: 'domcontentloaded' });
      const details = await inspectPage(page);
      const mapped = mapInventory(details);
      const unknown = mapped.find((field) => field.fieldKey === 'favourite_colour');
      expect(unknown?.intent).toBe('unknown');
      const refusal = validateAction(
        {
          kind: 'fill',
          stepId: 'details',
          fieldKey: 'favourite_colour',
          selector: '[name="favourite_colour"]',
          value: 'Blue',
          source: 'verified_fact',
          evidenceFactIds: ['11111111-1111-4111-8111-111111111111'],
        },
        contextFor({ inventory: details }),
      );
      expect(refusal).toMatchObject({ ok: false, code: 'unmapped_field' });

      await page.goto(`${origin}/apply/${sessionId}/questions`, { waitUntil: 'domcontentloaded' });
      const questions = await inspectPage(page);
      const sensitive = mapInventory(questions);
      expect(sensitive.every((field) => field.humanOnly || field.sensitive)).toBe(true);
      const sensitiveRefusal = validateAction(
        {
          kind: 'check',
          stepId: 'questions',
          fieldKey: 'disability',
          selector: '[name="disability"]',
          checked: true,
          value: 'No',
          source: 'verified_fact',
          evidenceFactIds: ['11111111-1111-4111-8111-111111111111'],
        },
        contextFor({ inventory: questions }),
      );
      expect(sensitiveRefusal.ok).toBe(false);

      await page.goto(`${origin}/apply/${sessionId}/checks`, { waitUntil: 'domcontentloaded' });
      const checks = await inspectPage(page);
      const checkIntents = mapInventory(checks).map((field) => field.intent);
      expect(checkIntents).toEqual(
        expect.arrayContaining(['human.captcha', 'human.mfa', 'human.assessment']),
      );

      await page.goto(`${origin}/apply/${sessionId}/declarations`, {
        waitUntil: 'domcontentloaded',
      });
      const declarations = await inspectPage(page);
      const declarationIntents = mapInventory(declarations).map((field) => field.intent);
      expect(declarationIntents).toEqual(
        expect.arrayContaining(['declaration.truth', 'consent.data_processing']),
      );
      expect(mapInventory(declarations).every((field) => field.humanOnly)).toBe(true);
    } finally {
      await session.close();
      await session.discardArtifacts();
    }
  }, 60_000);

  it('reveals the conditional visa question only when sponsorship is chosen', async () => {
    const sessionId = await startSession();
    const session = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const page = await session.open();
    try {
      await page.goto(`${origin}/apply/${sessionId}/details`, { waitUntil: 'domcontentloaded' });
      expect(await page.locator('#visa-row').isHidden()).toBe(true);
      await page.locator('input[name="right_to_work"][value="Sponsorship required"]').check();
      expect(await page.locator('#visa-row').isHidden()).toBe(false);
      const inventory = await inspectPage(page);
      expect(inventory.fields.some((field) => field.fieldKey === 'visa_type')).toBe(true);
    } finally {
      await session.close();
      await session.discardArtifacts();
    }
  }, 60_000);

  it('uploads only the approved CV', async () => {
    const sessionId = await startSession();
    const session = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const page = await session.open();
    const documentId = '22222222-2222-4222-8222-222222222222';
    const content = Buffer.from('%PDF-1.4 synthetic acceptance-suite document');
    const sha256 = (await import('node:crypto')).createHash('sha256').update(content).digest('hex');
    try {
      await page.goto(`${origin}/apply/${sessionId}/documents`, { waitUntil: 'domcontentloaded' });
      const inventory = await inspectPage(page);
      const executor = new ActionExecutor({
        page,
        session,
        context: contextFor({
          inventory,
          overrides: { approvedDocument: { documentId, sha256 } },
        }),
        secrets: [],
        provideDocument: () => Promise.resolve({ filename: 'synthetic-cv.pdf', bytes: content }),
      });
      const result = await executor.run([
        {
          kind: 'upload',
          stepId: 'documents',
          fieldKey: 'cv',
          selector: '[name="cv"]',
          documentId,
          sha256,
        },
        { kind: 'click_next', stepId: 'documents', selector: '#next' },
      ]);
      expect(result.stopped).toBe(false);
      const state = (await ats.inject({ method: 'GET', url: `/__state/${sessionId}` })).json<{
        files: Record<string, { filename: string }>;
      }>();
      expect(state.files.cv?.filename).toBe('synthetic-cv.pdf');
    } finally {
      await session.close();
      await session.discardArtifacts();
    }
  }, 60_000);

  it('stays on the step and reads the validation errors back when the form rejects it', async () => {
    await ats.inject({
      method: 'POST',
      url: '/__control',
      payload: { validationOnFirstAttempt: true },
    });
    const sessionId = await startSession();
    const session = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const page = await session.open();
    try {
      await page.goto(`${origin}/apply/${sessionId}/details`, { waitUntil: 'domcontentloaded' });
      const inventory = await inspectPage(page);
      const evidence = '11111111-1111-4111-8111-111111111111';
      const executor = new ActionExecutor({
        page,
        session,
        context: contextFor({ inventory }),
        secrets: [],
      });
      const fill = (fieldKey: string, value: string): BrowserAction => ({
        kind: 'fill',
        stepId: 'details',
        fieldKey,
        selector: `[name="${fieldKey}"]`,
        value,
        source: 'verified_fact',
        evidenceFactIds: [evidence],
      });

      // Round one: every required answer is present, and the form still rejects it.
      await executor.run([
        fill('first_name', syntheticApplicant.firstName),
        fill('last_name', syntheticApplicant.lastName),
        fill('email', syntheticApplicant.email),
        fill('phone', syntheticApplicant.phone),
        fill('years_experience', syntheticApplicant.years),
        fill('supporting_statement', syntheticApplicant.statement),
        {
          kind: 'select',
          stepId: 'details',
          fieldKey: 'contract_preference',
          selector: '[name="contract_preference"]',
          value: 'Permanent',
          source: 'verified_fact',
          evidenceFactIds: [evidence],
        },
        {
          kind: 'check',
          stepId: 'details',
          fieldKey: 'right_to_work',
          selector: '[name="right_to_work"]',
          checked: true,
          value: 'Yes',
          source: 'verified_fact',
          evidenceFactIds: [evidence],
        },
        { kind: 'click_next', stepId: 'details', selector: '#next' },
      ]);

      const rejected = await inspectPage(page);
      expect(rejected.stepId).toBe('details');
      expect(rejected.validationMessages.length).toBeGreaterThan(0);
      expect(rejected.validationMessages.join(' ')).toContain('rejected this attempt');

      // Round two: the same answers are accepted, so the loop resolves rather than spinning.
      const retry = new ActionExecutor({
        page,
        session,
        context: contextFor({ inventory: rejected }),
        secrets: [],
      });
      await retry.run([{ kind: 'click_next', stepId: 'details', selector: '#next' }]);
      expect(page.url()).toContain('/history');
    } finally {
      await session.close();
      await session.discardArtifacts();
    }
  }, 60_000);

  it('never navigates to a production application form', async () => {
    const session = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const page = await session.open();
    try {
      await page.goto(`${origin}/health`, { waitUntil: 'domcontentloaded' });
      const blocked = await page
        .goto('https://myjobscotland.gov.uk/', { waitUntil: 'domcontentloaded' })
        .then(() => 'reached')
        .catch(() => 'blocked');
      expect(blocked).toBe('blocked');
      expect(isLoopbackOrigin('https://myjobscotland.gov.uk/')).toBe(false);
    } finally {
      await session.close();
      await session.discardArtifacts();
    }
  }, 60_000);

  it('masks applicant values in screenshots and keeps them out of the report', async () => {
    const sessionId = await startSession();
    const session = new WorkerSession({
      targetOrigin: origin,
      secrets: [syntheticApplicant.phone],
    });
    const page = await session.open();
    try {
      await page.goto(`${origin}/apply/${sessionId}/details`, { waitUntil: 'domcontentloaded' });
      await page.fill('[name="phone"]', syntheticApplicant.phone);
      const inventory = await inspectPage(page);
      const executor = new ActionExecutor({
        page,
        session,
        context: contextFor({ inventory }),
        secrets: [syntheticApplicant.phone],
      });
      const shot = await session.captureScreenshot(page, 'redaction-check');
      expect(shot.redacted).toBe(true);
      const bytes = await readFile(shot.objectKey);
      expect(bytes.includes(Buffer.from(syntheticApplicant.phone))).toBe(false);

      const report = await executor.report({
        attemptId: '33333333-3333-4333-8333-333333333333',
        outcome: 'completed',
      });
      const serialised = JSON.stringify(report);
      expect(serialised).not.toContain(syntheticApplicant.phone);
      expect(serialised).not.toContain('<html');
      expect(Object.keys(report)).not.toContain('cookies');
      expect(Object.keys(report)).not.toContain('storageState');
    } finally {
      await session.close();
      await session.discardArtifacts();
    }
  }, 60_000);

  it('enters only values that were supplied, and nothing invented', async () => {
    const sessionId = await startSession();
    const session = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const page = await session.open();
    try {
      await page.goto(`${origin}/apply/${sessionId}/details`, { waitUntil: 'domcontentloaded' });
      const inventory = await inspectPage(page);
      const evidence = '11111111-1111-4111-8111-111111111111';
      const supplied: Record<string, string> = {
        first_name: syntheticApplicant.firstName,
        last_name: syntheticApplicant.lastName,
        email: syntheticApplicant.email,
        phone: syntheticApplicant.phone,
        years_experience: syntheticApplicant.years,
        supporting_statement: syntheticApplicant.statement,
      };
      const executor = new ActionExecutor({
        page,
        session,
        context: contextFor({ inventory }),
        secrets: Object.values(supplied),
      });
      await executor.run([
        ...Object.entries(supplied).map(([fieldKey, value]): BrowserAction => ({
          kind: 'fill',
          stepId: 'details',
          fieldKey,
          selector: `[name="${fieldKey}"]`,
          value,
          source: 'verified_fact',
          evidenceFactIds: [evidence],
        })),
        {
          kind: 'select',
          stepId: 'details',
          fieldKey: 'contract_preference',
          selector: '[name="contract_preference"]',
          value: 'Permanent',
          source: 'verified_fact',
          evidenceFactIds: [evidence],
        },
        {
          kind: 'check',
          stepId: 'details',
          fieldKey: 'right_to_work',
          selector: '[name="right_to_work"]',
          checked: true,
          value: 'Yes',
          source: 'verified_fact',
          evidenceFactIds: [evidence],
        },
        { kind: 'click_next', stepId: 'details', selector: '#next' },
      ]);

      const state: { values: Record<string, string> } = (
        await ats.inject({ method: 'GET', url: `/__state/${sessionId}` })
      ).json();
      // Every non-empty value the form received must be one the agent was explicitly given.
      const allowed = new Set<string>([...Object.values(supplied), 'Permanent', 'Yes']);
      const entries: Array<[string, string]> = Object.entries(state.values);
      for (const [key, value] of entries) {
        if (value.trim() === '') continue;
        expect(allowed.has(value), `unexpected value entered for ${key}: ${value}`).toBe(true);
      }
      expect(state.values.favourite_colour ?? '').toBe('');
      expect(state.values.referral_code ?? '').toBe('');
    } finally {
      await session.close();
      await session.discardArtifacts();
    }
  }, 60_000);

  it('performs exactly one final action and records one reference', async () => {
    const sessionId = await startSession();
    const session = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const page = await session.open();
    try {
      await page.goto(`${origin}/apply/${sessionId}/review`, { waitUntil: 'domcontentloaded' });
      const inventory = await inspectPage(page);
      const snapshotHash = 'a'.repeat(64);
      const { issueSubmitIntent } = await import('@job-agent/browser-core');
      const intent = issueSubmitIntent({ snapshotHash, now: new Date() });
      const executor = new ActionExecutor({
        page,
        session,
        context: contextFor({
          inventory,
          overrides: {
            workflowState: 'READY_TO_SUBMIT',
            currentStepId: 'review',
            submitGuard: {
              activeIntentTokenHash: intent.tokenHash,
              snapshotHash,
              expiresAt: intent.expiresAt,
              consumed: false,
            },
          },
        }),
        secrets: [],
      });
      const first = await executor.run([
        {
          kind: 'submit',
          stepId: 'review',
          selector: '#submit-application',
          intentToken: intent.token,
          snapshotHash,
        },
      ]);
      expect(first.stopped).toBe(false);
      expect(page.url()).toContain('/confirmation');
      const reference = await page.locator('#confirmation-reference').textContent();
      expect(reference).toMatch(/^FAKE-ATS-[A-Z0-9]{8}$/);

      // A replay of the same intent is refused before the browser is touched again.
      const replayExecutor = new ActionExecutor({
        page,
        session,
        context: contextFor({
          inventory,
          overrides: {
            workflowState: 'READY_TO_SUBMIT',
            currentStepId: 'review',
            submitGuard: {
              activeIntentTokenHash: intent.tokenHash,
              snapshotHash,
              expiresAt: intent.expiresAt,
              consumed: true,
            },
          },
        }),
        secrets: [],
      });
      const replay = await replayExecutor.run([
        {
          kind: 'submit',
          stepId: 'review',
          selector: '#submit-application',
          intentToken: intent.token,
          snapshotHash,
        },
      ]);
      expect(replay.outcomes[0]).toMatchObject({ kind: 'refused', code: 'submit_intent_consumed' });

      const state = (await ats.inject({ method: 'GET', url: `/__state/${sessionId}` })).json<{
        submitCount: number;
        reference: string;
      }>();
      expect(state.submitCount).toBe(1);
      expect(state.reference).toBe(reference);
    } finally {
      await session.close();
      await session.discardArtifacts();
    }
  }, 60_000);

  it('treats an unclear submission outcome as unknown rather than retrying', async () => {
    await ats.inject({
      method: 'POST',
      url: '/__control',
      payload: { submitOutcome: 'ambiguous' },
    });
    const sessionId = await startSession();
    const session = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const page = await session.open();
    try {
      await page.goto(`${origin}/apply/${sessionId}/review`, { waitUntil: 'domcontentloaded' });
      const inventory = await inspectPage(page);
      const snapshotHash = 'b'.repeat(64);
      const { issueSubmitIntent } = await import('@job-agent/browser-core');
      const intent = issueSubmitIntent({ snapshotHash, now: new Date() });
      const executor = new ActionExecutor({
        page,
        session,
        context: contextFor({
          inventory,
          overrides: {
            workflowState: 'READY_TO_SUBMIT',
            currentStepId: 'review',
            submitGuard: {
              activeIntentTokenHash: intent.tokenHash,
              snapshotHash,
              expiresAt: intent.expiresAt,
              consumed: false,
            },
          },
        }),
        secrets: [],
      });
      await executor.run([
        {
          kind: 'submit',
          stepId: 'review',
          selector: '#submit-application',
          intentToken: intent.token,
          snapshotHash,
        },
      ]);
      const report = await executor.report({
        attemptId: '44444444-4444-4444-8444-444444444444',
        outcome: 'completed',
      });
      expect(report.confirmationReference).toBeNull();
      const state = (await ats.inject({ method: 'GET', url: `/__state/${sessionId}` })).json<{
        submitCount: number;
      }>();
      expect(state.submitCount).toBe(1);
    } finally {
      await session.close();
      await session.discardArtifacts();
    }
  }, 60_000);

  it('does not share cookies or storage between attempts', async () => {
    const first = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const firstPage = await first.open();
    await firstPage.goto(`${origin}/health`, { waitUntil: 'domcontentloaded' });
    await firstPage.evaluate(() => {
      window.localStorage.setItem('leak-check', 'attempt-one');
    });
    await first.close();
    await first.discardArtifacts();

    const second = new WorkerSession({ targetOrigin: origin, secrets: [] });
    const secondPage = await second.open();
    await secondPage.goto(`${origin}/health`, { waitUntil: 'domcontentloaded' });
    const leaked: string | null = await secondPage.evaluate(() =>
      window.localStorage.getItem('leak-check'),
    );
    expect(leaked).toBeNull();
    await second.close();
    await second.discardArtifacts();
  }, 60_000);
});

describe('browser availability', () => {
  it('reports whether the acceptance suite could run here', () => {
    // Recorded rather than asserted, so a machine without browsers still shows why it skipped.
    expect(typeof browserAvailable).toBe('boolean');
  });
});
