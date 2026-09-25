import { z } from 'zod';

export const answerSources = [
  'verified_fact',
  'application_scoped_answer',
  'approved_document',
] as const;
export type AnswerSource = (typeof answerSources)[number];

export const questionReasons = [
  'unknown_field',
  'missing_evidence',
  'sensitive_question',
  'expired_fact',
  'unverified_fact',
  'use_policy_forbids',
  'ambiguous_mapping',
  'human_only_step',
  'validation_rejected',
] as const;
export type QuestionReason = (typeof questionReasons)[number];

export const responseKinds = ['text', 'choice', 'boolean', 'number', 'human_action'] as const;
export type ResponseKind = (typeof responseKinds)[number];

const stepId = z.string().min(1).max(80);
const fieldKey = z.string().min(1).max(120);
const selector = z.string().min(1).max(400);
const evidence = z.array(z.uuid()).max(20).default([]);

/**
 * The whole vocabulary the browser may execute. Anything outside this list cannot be expressed,
 * let alone run, and every member is checked by the action validator before execution.
 */
export const browserActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string().min(1).max(2048), expectStepId: stepId }),
  z.object({
    kind: z.literal('fill'),
    stepId,
    fieldKey,
    selector,
    value: z.string().max(20_000),
    source: z.enum(answerSources),
    evidenceFactIds: evidence,
  }),
  z.object({
    kind: z.literal('select'),
    stepId,
    fieldKey,
    selector,
    value: z.string().max(200),
    source: z.enum(answerSources),
    evidenceFactIds: evidence,
  }),
  z.object({
    kind: z.literal('check'),
    stepId,
    fieldKey,
    selector,
    checked: z.boolean(),
    value: z.string().max(200).optional(),
    source: z.enum(answerSources),
    evidenceFactIds: evidence,
  }),
  z.object({
    kind: z.literal('upload'),
    stepId,
    fieldKey,
    selector,
    documentId: z.uuid(),
    sha256: z.string().length(64),
  }),
  z.object({ kind: z.literal('click_next'), stepId, selector }),
  z.object({
    kind: z.literal('request_user'),
    stepId,
    fieldKey,
    reason: z.enum(questionReasons),
    prompt: z.string().min(1).max(600),
    responseKind: z.enum(responseKinds),
    allowedValues: z.array(z.string().max(200)).max(40).default([]),
  }),
  z.object({ kind: z.literal('capture_review'), stepId }),
  z.object({
    kind: z.literal('submit'),
    stepId,
    selector,
    intentToken: z.string().min(32).max(200),
    snapshotHash: z.string().length(64),
  }),
]);

export type BrowserAction = z.infer<typeof browserActionSchema>;
export type FillLikeAction = Extract<BrowserAction, { kind: 'fill' | 'select' | 'check' }>;

export const browserPlanSchema = z.object({
  attemptId: z.uuid(),
  stepId,
  actions: z.array(browserActionSchema).min(1).max(200),
});
export type BrowserPlan = z.infer<typeof browserPlanSchema>;

/**
 * A plan carries applicant values, so it is a secret. It is never logged, never persisted in the
 * clear, and never returned from the worker.
 */
export function describeActionForLog(action: BrowserAction): Record<string, unknown> {
  switch (action.kind) {
    case 'navigate':
      return { kind: action.kind, expectStepId: action.expectStepId };
    case 'fill':
    case 'select':
      return {
        kind: action.kind,
        stepId: action.stepId,
        fieldKey: action.fieldKey,
        source: action.source,
        valueLength: action.value.length,
      };
    case 'check':
      return { kind: action.kind, stepId: action.stepId, fieldKey: action.fieldKey };
    case 'upload':
      return { kind: action.kind, stepId: action.stepId, fieldKey: action.fieldKey };
    case 'click_next':
      return { kind: action.kind, stepId: action.stepId };
    case 'request_user':
      return {
        kind: action.kind,
        stepId: action.stepId,
        fieldKey: action.fieldKey,
        reason: action.reason,
      };
    case 'capture_review':
      return { kind: action.kind, stepId: action.stepId };
    case 'submit':
      return { kind: action.kind, stepId: action.stepId };
  }
}
