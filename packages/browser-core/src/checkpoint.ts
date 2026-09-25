import { z } from 'zod';

export const checkpointSchema = z.object({
  attemptId: z.uuid(),
  adapterId: z.string().min(1).max(60),
  adapterVersion: z.string().min(1).max(40),
  currentStepId: z.string().min(1).max(80),
  currentUrl: z.string().min(1).max(2048),
  pageFingerprint: z.string().length(64),
  completedStepIds: z.array(z.string().max(80)).max(60),
  /** Field keys and answer hashes only. No applicant value is ever written to a checkpoint. */
  fieldHashes: z.record(z.string().max(160), z.string().length(64)),
  validationMessages: z.array(z.string().max(400)).max(50),
  pendingReason: z.string().max(120).nullable(),
  lastSafeAction: z.string().max(80).nullable(),
  artifactRefs: z.array(z.string().max(200)).max(50),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});

export type Checkpoint = z.infer<typeof checkpointSchema>;

export const CHECKPOINT_TTL_HOURS = 24;

export function newCheckpoint(input: {
  attemptId: string;
  adapterId: string;
  adapterVersion: string;
  currentStepId: string;
  currentUrl: string;
  pageFingerprint: string;
  now: Date;
}): Checkpoint {
  return {
    attemptId: input.attemptId,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    currentStepId: input.currentStepId,
    currentUrl: input.currentUrl,
    pageFingerprint: input.pageFingerprint,
    completedStepIds: [],
    fieldHashes: {},
    validationMessages: [],
    pendingReason: null,
    lastSafeAction: null,
    artifactRefs: [],
    createdAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + CHECKPOINT_TTL_HOURS * 3_600_000).toISOString(),
  };
}

export function advanceCheckpoint(
  checkpoint: Checkpoint,
  patch: Partial<Omit<Checkpoint, 'attemptId' | 'createdAt'>>,
): Checkpoint {
  return checkpointSchema.parse({
    ...checkpoint,
    ...patch,
    completedStepIds: [
      ...new Set([...checkpoint.completedStepIds, ...(patch.completedStepIds ?? [])]),
    ],
    fieldHashes: { ...checkpoint.fieldHashes, ...(patch.fieldHashes ?? {}) },
  });
}

/**
 * A resumed attempt must find the same adapter version and the same page. Anything else is treated
 * as a changed form, which invalidates the approval rather than being worked around.
 */
export function checkpointStillValid(
  checkpoint: Checkpoint,
  observed: { adapterVersion: string; stepId: string; pageFingerprint: string },
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  if (new Date(checkpoint.expiresAt) <= now) return { ok: false, reason: 'checkpoint_expired' };
  if (checkpoint.adapterVersion !== observed.adapterVersion) {
    return { ok: false, reason: 'adapter_version_changed' };
  }
  if (checkpoint.currentStepId !== observed.stepId) return { ok: false, reason: 'step_changed' };
  if (checkpoint.pageFingerprint !== observed.pageFingerprint) {
    return { ok: false, reason: 'form_changed' };
  }
  return { ok: true };
}
