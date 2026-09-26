import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { WorkerRunOutcome, WorkerTransport } from '@job-agent/orchestrator';
import { redact, silentLogger, type StructuredLogger } from '@job-agent/observability';

/**
 * Environment names the worker is allowed to inherit. Everything else is withheld, so the
 * encryption key, the admin token and the Discord credentials cannot reach a process that drives a
 * browser. Playwright needs to find its own browser download, which is what the rest of these are
 * for.
 */
const INHERITED_ENV = [
  'PATH',
  'Path',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'HOME',
  'PLAYWRIGHT_BROWSERS_PATH',
] as const;

export type SpawnWorkerTransportOptions = {
  /** Defaults to the bundled worker's entry point, resolved from this file. */
  entryPoint?: string;
  timeoutMs?: number;
  logger?: StructuredLogger;
};

function defaultEntryPoint(): string {
  // apps/api/dist/worker-transport.js -> apps/browser-worker/dist/main.js
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'browser-worker', 'dist', 'main.js');
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/**
 * Runs one worker request in its own short-lived process.
 *
 * The isolation the architecture asks for is the point of this class: a fresh process per request,
 * a withheld environment, no shared memory with the control plane, and a hard timeout. Only the
 * sanitised JSON report crosses back. Anything the child writes to stderr is dropped rather than
 * logged, because the request that produced it carries applicant answers.
 */
export class SpawnWorkerTransport implements WorkerTransport {
  private readonly entryPoint: string;
  private readonly timeoutMs: number;
  private readonly logger: StructuredLogger;

  constructor(options: SpawnWorkerTransportOptions = {}) {
    this.entryPoint = options.entryPoint ?? defaultEntryPoint();
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.logger = options.logger ?? silentLogger;
  }

  async run(request: Record<string, unknown>): Promise<WorkerRunOutcome> {
    return new Promise<WorkerRunOutcome>((resolve) => {
      const child = spawn(process.execPath, [this.entryPoint], {
        env: childEnvironment(),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });

      let stdout = '';
      let settled = false;
      const finish = (outcome: WorkerRunOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        this.logger.log('warn', 'The browser worker timed out and was stopped', {
          timeoutMs: this.timeoutMs,
        });
        finish({ ok: false, errorCode: 'worker_timeout' });
      }, this.timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        // Bounded so a runaway child cannot exhaust the control plane's memory.
        if (stdout.length < 4_000_000) stdout += chunk;
      });

      child.on('error', (error) => {
        this.logger.log('error', 'The browser worker could not be started', {
          errorMessage: redact(error.message),
        });
        finish({ ok: false, errorCode: 'worker_unavailable' });
      });

      child.on('close', () => {
        const line = stdout.trim().split('\n').at(-1) ?? '';
        if (line === '') return finish({ ok: false, errorCode: 'worker_no_output' });
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed !== 'object' || parsed === null) {
            return finish({ ok: false, errorCode: 'worker_bad_output' });
          }
          return finish(parsed as WorkerRunOutcome);
        } catch {
          // The raw output is not logged: it is the worker's report, not a diagnostic.
          return finish({ ok: false, errorCode: 'worker_bad_output' });
        }
      });

      child.stdin.end(JSON.stringify(request), 'utf8');
    });
  }
}
