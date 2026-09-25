import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fakeAtsAdapter } from '@job-agent/adapters';
import { mapInventory } from '@job-agent/browser-core';
import { buildFakeAts, type FakeAtsApp } from '@job-agent/fake-ats';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const browserAvailable = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const workerEntry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const suite = browserAvailable && existsSync(workerEntry) ? describe : describe.skip;

let ats: FakeAtsApp;
let origin = '';

const PHONE = '07700900000';

/** Reads the redirect target without a non-null assertion. */
function locationOf(headers: Record<string, unknown>): string {
  const location = headers.location;
  return typeof location === 'string' ? location : '';
}

function runWorkerProcess(
  request: unknown,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerEntry], {
      cwd: path.dirname(workerEntry),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}

beforeAll(async () => {
  ats = buildFakeAts();
  await ats.listen({ host: '127.0.0.1', port: 0 });
  const address = ats.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${String(port)}`;
});

afterAll(async () => {
  await ats.close();
});

suite('the worker process boundary', () => {
  it('runs in its own process and returns nothing but a sanitised report', async () => {
    const start = await ats.inject({ method: 'POST', url: '/apply/JOB-BOUNDARY/start' });
    const sessionId = locationOf(start.headers).split('/')[2] ?? '';
    const adapter = fakeAtsAdapter(origin);

    const inventoryRequest = {
      attemptId: '55555555-5555-4555-8555-555555555555',
      workflowState: 'FILLING',
      adapter,
      currentStepId: 'details',
      startUrl: `${origin}/apply/${sessionId}/details`,
      mappedFields: [],
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
      secrets: [],
      actions: [],
      headless: true,
    };

    const inspected = await runWorkerProcess(inventoryRequest);
    expect(inspected.code).toBe(0);
    const inspectedBody = JSON.parse(inspected.stdout.trim()) as {
      ok: boolean;
      report: { inventory: { fields: Array<{ fieldKey: string; controlType: string }> } };
    };
    expect(inspectedBody.ok).toBe(true);

    const mapped = mapInventory({
      stepId: 'details',
      url: `${origin}/apply/${sessionId}/details`,
      pageFingerprint: 'a'.repeat(64),
      fields: inspectedBody.report.inventory.fields as never,
      validationMessages: [],
      humanOnlyMarkers: [],
    });

    const fillRequest = {
      ...inventoryRequest,
      mappedFields: mapped,
      secrets: [PHONE],
      actions: [
        {
          kind: 'fill',
          stepId: 'details',
          fieldKey: 'phone',
          selector: '[name="phone"]',
          value: PHONE,
          source: 'verified_fact',
          evidenceFactIds: ['11111111-1111-4111-8111-111111111111'],
        },
      ],
    };

    const filled = await runWorkerProcess(fillRequest);
    expect(filled.code).toBe(0);

    // The applicant value went in on stdin and does not come back out on stdout or stderr.
    expect(filled.stdout).not.toContain(PHONE);
    expect(filled.stderr).not.toContain(PHONE);
    const body = JSON.parse(filled.stdout.trim()) as {
      ok: boolean;
      report: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    for (const forbidden of [
      'cookies',
      'storageState',
      'localStorage',
      'html',
      'pageText',
      'values',
    ]) {
      expect(Object.keys(body.report)).not.toContain(forbidden);
    }
    expect(JSON.stringify(body.report)).not.toContain(PHONE);
  }, 120_000);

  it('refuses a destination outside the fake ATS and says nothing more', async () => {
    const response = await runWorkerProcess({
      attemptId: '66666666-6666-4666-8666-666666666666',
      workflowState: 'FILLING',
      adapter: { ...fakeAtsAdapter(origin), targetOrigin: 'https://myjobscotland.gov.uk' },
      currentStepId: 'details',
      startUrl: 'https://myjobscotland.gov.uk/apply/1',
      mappedFields: [],
      sitePolicy: {
        origin: 'https://myjobscotland.gov.uk',
        applyMode: 'manual_only',
        submitPermitted: false,
      },
      approvedDocument: null,
      submitGuard: {
        activeIntentTokenHash: null,
        snapshotHash: null,
        expiresAt: null,
        consumed: false,
      },
      takeoverActive: false,
      paused: false,
      secrets: [],
      actions: [],
      headless: true,
    });
    expect(response.code).toBe(1);
    const body = JSON.parse(response.stdout.trim()) as { ok: boolean; errorCode: string };
    expect(body.ok).toBe(false);
    expect(Object.keys(body)).toEqual(['ok', 'errorCode']);
  }, 60_000);
});
