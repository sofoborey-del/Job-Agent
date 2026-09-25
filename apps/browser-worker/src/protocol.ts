import {
  adapterContractSchema,
  browserActionSchema,
  observedFieldSchema,
  fieldIntents,
} from '@job-agent/browser-core';
import { z } from 'zod';

/**
 * The full request the control plane hands the worker. It crosses a process boundary, so it is a
 * plain, validated structure. It carries applicant values for the fields being filled, which is
 * exactly why the worker never writes it to a log and never echoes it back.
 */
export const workerRequestSchema = z.object({
  attemptId: z.uuid(),
  workflowState: z.string().min(1).max(40),
  adapter: adapterContractSchema,
  currentStepId: z.string().min(1).max(80),
  startUrl: z.string().min(1).max(2048),
  mappedFields: z.array(
    observedFieldSchema.extend({
      intent: z.enum(fieldIntents),
      confidence: z.number().min(0).max(1),
      sensitive: z.boolean(),
      humanOnly: z.boolean(),
    }),
  ),
  sitePolicy: z.object({
    origin: z.string().min(1).max(200),
    applyMode: z.string().min(1).max(40),
    submitPermitted: z.boolean(),
  }),
  approvedDocument: z
    .object({
      documentId: z.uuid(),
      sha256: z.string().length(64),
      filename: z.string().min(1).max(200),
      contentBase64: z.string().max(10_000_000),
    })
    .nullable(),
  submitGuard: z.object({
    activeIntentTokenHash: z.string().length(64).nullable(),
    snapshotHash: z.string().length(64).nullable(),
    expiresAt: z.string().max(40).nullable(),
    consumed: z.boolean(),
  }),
  takeoverActive: z.boolean(),
  paused: z.boolean(),
  secrets: z.array(z.string().max(20_000)).max(200),
  actions: z.array(browserActionSchema).max(200),
  headless: z.boolean().default(true),
});

export type WorkerRequest = z.infer<typeof workerRequestSchema>;
