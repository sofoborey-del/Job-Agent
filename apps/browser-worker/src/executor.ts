import {
  describeActionForLog,
  redactStrings,
  sanitiseWorkerReport,
  validateAction,
  type BrowserAction,
  type ValidationContext,
} from '@job-agent/browser-core';
import { silentLogger, type StructuredLogger } from '@job-agent/observability';
import type { Page } from 'playwright';

import { inspectPage } from './inspector.js';
import type { WorkerSession } from './session.js';

export type ActionOutcome =
  | { kind: 'done'; action: string }
  | { kind: 'refused'; action: string; code: string; message: string }
  | { kind: 'paused'; action: string; reason: string };

export type ExecuteResult = {
  outcomes: ActionOutcome[];
  stopped: boolean;
};

export type DocumentProvider = (documentId: string) => Promise<{ filename: string; bytes: Buffer }>;

export type ExecutorOptions = {
  page: Page;
  session: WorkerSession;
  context: ValidationContext;
  provideDocument?: DocumentProvider;
  logger?: StructuredLogger;
  secrets: readonly string[];
};

/**
 * Executes only actions that pass the validator, one at a time, stopping at the first refusal.
 * The browser is an executor here, never a planner: it cannot decide to do anything else.
 */
export class ActionExecutor {
  private readonly logger: StructuredLogger;

  constructor(private readonly options: ExecutorOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  async run(actions: readonly BrowserAction[]): Promise<ExecuteResult> {
    const outcomes: ActionOutcome[] = [];
    for (const action of actions) {
      const check = validateAction(action, this.options.context);
      if (!check.ok) {
        outcomes.push({
          kind: 'refused',
          action: action.kind,
          code: check.code,
          message: check.message,
        });
        this.logger.log('warn', 'Browser action refused', {
          ...describeActionForLog(action),
          code: check.code,
        });
        return { outcomes, stopped: true };
      }
      if (action.kind === 'request_user') {
        outcomes.push({ kind: 'paused', action: action.kind, reason: action.reason });
        return { outcomes, stopped: true };
      }
      await this.execute(action);
      outcomes.push({ kind: 'done', action: action.kind });
      this.logger.log('debug', 'Browser action executed', describeActionForLog(action));
    }
    return { outcomes, stopped: false };
  }

  private async execute(action: BrowserAction): Promise<void> {
    const { page } = this.options;
    switch (action.kind) {
      case 'navigate':
        await page.goto(action.url, { waitUntil: 'domcontentloaded' });
        return;
      case 'fill':
        await page.fill(action.selector, action.value);
        return;
      case 'select':
        await page.selectOption(action.selector, action.value);
        return;
      case 'check': {
        const locator = page.locator(`${action.selector}[value="${action.value ?? ''}"]`);
        const target =
          (await locator.count()) > 0 ? locator : page.locator(action.selector).first();
        if (action.checked) await target.check();
        else await target.uncheck();
        return;
      }
      case 'upload': {
        if (this.options.provideDocument === undefined) {
          throw new Error('no document provider is configured for this worker');
        }
        const document = await this.options.provideDocument(action.documentId);
        // The approved document is materialised inside this session's own directory, which is
        // removed when the session closes. No path from outside the worker is ever used.
        const scratch = await this.options.session.materialiseUpload(
          document.filename,
          document.bytes,
        );
        await page.setInputFiles(action.selector, scratch);
        return;
      }
      case 'click_next':
        await Promise.all([page.waitForLoadState('domcontentloaded'), page.click(action.selector)]);
        await page.waitForLoadState('domcontentloaded');
        return;
      case 'submit':
        await page.click(action.selector);
        await page.waitForLoadState('domcontentloaded');
        return;
      case 'capture_review':
        await this.options.session.captureScreenshot(page, `review-${action.stepId}`);
        return;
      case 'request_user':
        return;
    }
  }

  /** The only shape allowed out of the worker, with every applicant value already removed. */
  async report(input: {
    attemptId: string;
    outcome: string;
    errorCode?: string | null;
  }): Promise<Record<string, unknown>> {
    const { page } = this.options;
    const inventory = await inspectPage(page);
    // Short timeout on purpose: most pages have no confirmation element, and waiting for one that
    // will never appear must not slow every report down.
    const reference = await page
      .locator('#confirmation-reference')
      .textContent({ timeout: 1000 })
      .catch(() => null);
    return sanitiseWorkerReport({
      attemptId: input.attemptId,
      stepId: inventory.stepId,
      url: page.url(),
      pageFingerprint: inventory.pageFingerprint,
      inventory: {
        ...inventory,
        validationMessages: redactStrings(inventory.validationMessages, {
          secrets: this.options.secrets,
        }),
      },
      validationMessages: redactStrings(inventory.validationMessages, {
        secrets: this.options.secrets,
      }),
      artifacts: this.options.session.artifacts,
      outcome: input.outcome,
      confirmationReference: reference === null ? null : reference.trim(),
      errorCode: input.errorCode ?? null,
    });
  }
}
