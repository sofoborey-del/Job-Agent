import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SpawnWorkerTransport } from './worker-transport.js';

let directory: string;

/** Writes a stand-in worker so these tests never start a browser. */
async function fakeWorker(body: string): Promise<string> {
  const file = path.join(directory, `worker-${String(Math.random()).slice(2)}.mjs`);
  await writeFile(file, body, 'utf8');
  return file;
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'worker-transport-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('the isolated worker transport', () => {
  it('returns the sanitised report the worker printed', async () => {
    const entryPoint = await fakeWorker(
      `process.stdin.resume();
       process.stdout.write(JSON.stringify({ ok: true, report: { stepId: 'details' } }) + '\\n');
       process.exit(0);`,
    );
    const transport = new SpawnWorkerTransport({ entryPoint });
    await expect(transport.run({ attemptId: 'a' })).resolves.toMatchObject({
      ok: true,
      report: { stepId: 'details' },
    });
  });

  it('passes the request on stdin and nothing on the command line', async () => {
    const entryPoint = await fakeWorker(
      `let raw = '';
       for await (const chunk of process.stdin) raw += chunk;
       process.stdout.write(JSON.stringify({
         ok: true,
         report: { received: JSON.parse(raw).marker, argv: process.argv.slice(2) },
       }) + '\\n');`,
    );
    const transport = new SpawnWorkerTransport({ entryPoint });
    const result = await transport.run({ marker: 'only-on-stdin' });
    expect(result).toMatchObject({ report: { received: 'only-on-stdin', argv: [] } });
  });

  /**
   * The reason this transport exists. A process that drives a browser must not be handed the
   * encryption key, the admin token or the Discord credentials.
   */
  it('withholds the control plane secrets from the worker process', async () => {
    const secrets = {
      APP_ENCRYPTION_KEY_BASE64: 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
      PROFILE_ADMIN_TOKEN: 'admin-token-value',
      DISCORD_BOT_TOKEN: 'discord-token-value',
      DATABASE_URL: 'postgres://user:password@127.0.0.1/db',
    };
    for (const [name, value] of Object.entries(secrets)) process.env[name] = value;
    try {
      const entryPoint = await fakeWorker(
        `process.stdin.resume();
         process.stdout.write(JSON.stringify({
           ok: true,
           report: { names: Object.keys(process.env) },
         }) + '\\n');
         process.exit(0);`,
      );
      const transport = new SpawnWorkerTransport({ entryPoint });
      const result = await transport.run({});
      const names = (result.report as unknown as { names: string[] }).names;
      for (const name of Object.keys(secrets)) expect(names).not.toContain(name);
      // It still gets what Playwright needs to find its browser.
      expect(names.some((name) => name.toLowerCase() === 'path')).toBe(true);
    } finally {
      for (const name of Object.keys(secrets)) Reflect.deleteProperty(process.env, name);
    }
  });

  it('reports a failure rather than the worker output when the output is not JSON', async () => {
    const entryPoint = await fakeWorker(
      `process.stdin.resume();
       process.stdout.write('an applicant answer leaked into a crash dump\\n');
       process.exit(1);`,
    );
    const transport = new SpawnWorkerTransport({ entryPoint });
    const result = await transport.run({});
    expect(result).toEqual({ ok: false, errorCode: 'worker_bad_output' });
    expect(JSON.stringify(result)).not.toContain('applicant answer');
  });

  it('stops a worker that hangs, instead of holding the request open', async () => {
    const entryPoint = await fakeWorker(`setInterval(() => {}, 1000);`);
    const transport = new SpawnWorkerTransport({ entryPoint, timeoutMs: 300 });
    await expect(transport.run({})).resolves.toEqual({ ok: false, errorCode: 'worker_timeout' });
  });

  it('reports a missing worker rather than throwing', async () => {
    const transport = new SpawnWorkerTransport({
      entryPoint: path.join(directory, 'does-not-exist.mjs'),
    });
    const result = await transport.run({});
    expect(result.ok).toBe(false);
    expect(['worker_unavailable', 'worker_no_output']).toContain(result.errorCode);
  });
});
