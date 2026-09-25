import { hashSubmitToken, type ValidationContext } from '@job-agent/browser-core';
import type { ApplicationState } from '@job-agent/domain';
import { silentLogger, type StructuredLogger } from '@job-agent/observability';

import { ActionExecutor, type ActionOutcome } from './executor.js';
import type { WorkerRequest } from './protocol.js';
import { WorkerSession } from './session.js';

export type WorkerRunResult = {
  report: Record<string, unknown>;
  outcomes: ActionOutcome[];
};

/**
 * One attempt inside the isolated worker: open a private context, run only validated actions, then
 * return a report that contains no applicant value, no cookie and no page text.
 */
export async function runWorkerRequest(
  request: WorkerRequest,
  logger: StructuredLogger = silentLogger,
): Promise<WorkerRunResult> {
  const session = new WorkerSession({
    targetOrigin: request.adapter.targetOrigin,
    headless: request.headless,
    secrets: request.secrets,
  });
  const page = await session.open();
  try {
    await page.goto(request.startUrl, { waitUntil: 'domcontentloaded' });

    const context: ValidationContext = {
      workflowState: request.workflowState as ApplicationState,
      adapter: request.adapter,
      currentStepId: request.currentStepId,
      mappedFields: request.mappedFields,
      sitePolicy: request.sitePolicy,
      approvedDocument:
        request.approvedDocument === null
          ? null
          : {
              documentId: request.approvedDocument.documentId,
              sha256: request.approvedDocument.sha256,
            },
      submitGuard: request.submitGuard,
      takeoverActive: request.takeoverActive,
      paused: request.paused,
      hashToken: hashSubmitToken,
      now: new Date(),
    };

    const executor = new ActionExecutor({
      page,
      session,
      context,
      logger,
      secrets: request.secrets,
      ...(request.approvedDocument === null
        ? {}
        : {
            provideDocument: (documentId: string) => {
              if (documentId !== request.approvedDocument?.documentId) {
                return Promise.reject(new Error('unknown document'));
              }
              return Promise.resolve({
                filename: request.approvedDocument.filename,
                bytes: Buffer.from(request.approvedDocument.contentBase64, 'base64'),
              });
            },
          }),
    });

    const result = await executor.run(request.actions);
    const refusal = result.outcomes.find((outcome) => outcome.kind === 'refused');
    const paused = result.outcomes.find((outcome) => outcome.kind === 'paused');
    const outcome =
      refusal !== undefined ? 'refused' : paused !== undefined ? 'paused' : 'completed';
    const report = await executor.report({
      attemptId: request.attemptId,
      outcome,
      errorCode: refusal === undefined ? null : refusal.code,
    });
    return { report, outcomes: result.outcomes };
  } finally {
    await session.close();
  }
}
