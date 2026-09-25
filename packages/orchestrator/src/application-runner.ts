import type { ApplicationWorkflowService } from '@job-agent/application';
import {
  fieldInventorySchema,
  mapInventory,
  stepById,
  type AdapterContract,
  type BrowserAction,
  type FieldInventory,
} from '@job-agent/browser-core';
import type { KnowledgeFact } from '@job-agent/domain';
import { newCorrelationId, silentLogger, type StructuredLogger } from '@job-agent/observability';

export type WorkerReportShape = {
  attemptId: string;
  stepId: string;
  url: string;
  pageFingerprint: string;
  inventory: unknown;
  validationMessages: string[];
  artifacts: Array<{
    kind: string;
    objectKey: string;
    sha256: string;
    bytes: number;
    redacted: boolean;
  }>;
  outcome: string;
  confirmationReference: string | null;
  errorCode: string | null;
};

export type WorkerRunOutcome = {
  ok: boolean;
  report?: WorkerReportShape;
  outcomes?: Array<{
    kind: string;
    action: string;
    code?: string;
    message?: string;
    reason?: string;
  }>;
  errorCode?: string;
};

/** How the control plane reaches the isolated worker. In production this is a separate process. */
export interface WorkerTransport {
  run(request: Record<string, unknown>): Promise<WorkerRunOutcome>;
}

export type ApplicationRunnerOptions = {
  workflow: ApplicationWorkflowService;
  transport: WorkerTransport;
  adapter: AdapterContract;
  logger?: StructuredLogger;
};

export type RunOutcome = {
  finishedStepIds: string[];
  pausedAt: string | null;
  pauseReason: string | null;
  refusal: { code: string; message: string } | null;
  reachedReview: boolean;
};

const MAX_STEPS = 12;
const MAX_VALIDATION_ROUNDS = 3;

/**
 * Drives one fake-ATS attempt: inspect the page, plan only what the policies allow, run it in the
 * isolated worker, checkpoint, and stop the moment a question, a human-only step or a refusal
 * appears. It never decides to submit; that is a separate, explicitly approved step.
 */
export class ApplicationRunner {
  private readonly logger: StructuredLogger;

  constructor(private readonly options: ApplicationRunnerOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  async runUntilPause(input: {
    attemptId: string;
    startUrl: string;
    facts: readonly KnowledgeFact<unknown>[];
    approvedDocument: {
      documentId: string;
      sha256: string;
      filename: string;
      contentBase64: string;
    } | null;
    sitePolicy: { origin: string; applyMode: string; submitPermitted: boolean };
    correlationId?: string;
    now?: Date;
  }): Promise<RunOutcome> {
    const correlationId = input.correlationId ?? newCorrelationId();
    const finishedStepIds: string[] = [];
    let url = input.startUrl;

    for (let stepCount = 0; stepCount < MAX_STEPS; stepCount += 1) {
      const inspection = await this.options.transport.run(
        this.request({
          attemptId: input.attemptId,
          startUrl: url,
          actions: [],
          input,
          stepId: 'details',
        }),
      );
      if (!inspection.ok || inspection.report === undefined) {
        return {
          finishedStepIds,
          pausedAt: null,
          pauseReason: 'worker_failed',
          refusal: {
            code: inspection.errorCode ?? 'worker_failed',
            message: 'The worker could not read the page.',
          },
          reachedReview: false,
        };
      }
      const inventory = this.parseInventory(inspection.report);
      url = inspection.report.url;

      if (inventory.stepId === 'review') {
        return {
          finishedStepIds,
          pausedAt: 'review',
          pauseReason: null,
          refusal: null,
          reachedReview: true,
        };
      }
      if (stepById(this.options.adapter, inventory.stepId) === null) {
        return {
          finishedStepIds,
          pausedAt: inventory.stepId,
          pauseReason: 'unknown_step',
          refusal: { code: 'unknown_step', message: 'That page is not part of the adapter.' },
          reachedReview: false,
        };
      }

      let round = 0;
      let advanced = false;
      let currentInventory = inventory;

      while (round < MAX_VALIDATION_ROUNDS && !advanced) {
        round += 1;
        const plan = await this.options.workflow.planStep({
          attemptId: input.attemptId,
          inventory: currentInventory,
          facts: input.facts,
          approvedDocument:
            input.approvedDocument === null
              ? null
              : {
                  documentId: input.approvedDocument.documentId,
                  sha256: input.approvedDocument.sha256,
                },
          correlationId,
          now: input.now ?? new Date(),
        });

        if (plan.pauseReason !== null) {
          return {
            finishedStepIds,
            pausedAt: currentInventory.stepId,
            pauseReason: plan.pauseReason,
            refusal: null,
            reachedReview: false,
          };
        }

        const run = await this.options.transport.run(
          this.request({
            attemptId: input.attemptId,
            startUrl: url,
            actions: plan.actions,
            input,
            stepId: currentInventory.stepId,
            mappedFields: mapInventory(currentInventory),
            secrets: plan.secrets,
          }),
        );
        if (!run.ok || run.report === undefined) {
          return {
            finishedStepIds,
            pausedAt: currentInventory.stepId,
            pauseReason: 'worker_failed',
            refusal: {
              code: run.errorCode ?? 'worker_failed',
              message: 'The worker could not run the step.',
            },
            reachedReview: false,
          };
        }
        const refused = run.outcomes?.find((outcome) => outcome.kind === 'refused');
        if (refused !== undefined) {
          return {
            finishedStepIds,
            pausedAt: currentInventory.stepId,
            pauseReason: 'action_refused',
            refusal: {
              code: refused.code ?? 'refused',
              message: refused.message ?? 'Action refused.',
            },
            reachedReview: false,
          };
        }

        url = run.report.url;
        const result = await this.options.workflow.recordStepResult({
          attemptId: input.attemptId,
          stepId: currentInventory.stepId,
          validationMessages: run.report.validationMessages,
          round,
          correlationId,
          now: input.now ?? new Date(),
        });
        if (result.question !== null) {
          return {
            finishedStepIds,
            pausedAt: currentInventory.stepId,
            pauseReason: 'validation_rejected',
            refusal: null,
            reachedReview: false,
          };
        }
        if (result.retry) {
          currentInventory = this.parseInventory(run.report);
          continue;
        }
        advanced = true;
        finishedStepIds.push(currentInventory.stepId);
        this.logger.log('info', 'Fake ATS step completed', {
          attemptId: input.attemptId,
          stepId: currentInventory.stepId,
        });
      }

      if (!advanced) {
        return {
          finishedStepIds,
          pausedAt: currentInventory.stepId,
          pauseReason: 'validation_rejected',
          refusal: null,
          reachedReview: false,
        };
      }
    }

    return {
      finishedStepIds,
      pausedAt: null,
      pauseReason: 'step_limit_reached',
      refusal: null,
      reachedReview: false,
    };
  }

  private parseInventory(report: WorkerReportShape): FieldInventory {
    return fieldInventorySchema.parse(report.inventory);
  }

  private request(input: {
    attemptId: string;
    startUrl: string;
    actions: BrowserAction[];
    stepId: string;
    mappedFields?: ReturnType<typeof mapInventory>;
    secrets?: string[];
    input: {
      approvedDocument: {
        documentId: string;
        sha256: string;
        filename: string;
        contentBase64: string;
      } | null;
      sitePolicy: { origin: string; applyMode: string; submitPermitted: boolean };
    };
  }): Record<string, unknown> {
    return {
      attemptId: input.attemptId,
      workflowState: 'FILLING',
      adapter: this.options.adapter,
      currentStepId: input.stepId,
      startUrl: input.startUrl,
      mappedFields: input.mappedFields ?? [],
      sitePolicy: input.input.sitePolicy,
      approvedDocument: input.input.approvedDocument,
      submitGuard: {
        activeIntentTokenHash: null,
        snapshotHash: null,
        expiresAt: null,
        consumed: false,
      },
      takeoverActive: false,
      paused: false,
      secrets: input.secrets ?? [],
      actions: input.actions,
      headless: true,
    };
  }
}
