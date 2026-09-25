import type { ApplicationState } from '@job-agent/domain';

import type { BrowserAction } from './actions.js';
import { stepById, type AdapterContract } from './adapter.js';
import { isConfidentlyMapped, type MappedField } from './inventory.js';

export type ActionRefusal = { ok: false; code: string; message: string };
export type ActionApproval = { ok: true };
export type ActionCheck = ActionApproval | ActionRefusal;

export type SubmitGuardView = {
  activeIntentTokenHash: string | null;
  snapshotHash: string | null;
  expiresAt: string | null;
  consumed: boolean;
};

export type ApprovedDocumentView = {
  documentId: string;
  sha256: string;
};

export type ValidationContext = {
  workflowState: ApplicationState;
  adapter: AdapterContract;
  currentStepId: string;
  mappedFields: MappedField[];
  sitePolicy: { origin: string; applyMode: string; submitPermitted: boolean };
  approvedDocument: ApprovedDocumentView | null;
  submitGuard: SubmitGuardView;
  takeoverActive: boolean;
  paused: boolean;
  hashToken: (token: string) => string;
  now: Date;
};

const statesThatMayAct: readonly ApplicationState[] = [
  'STARTING',
  'FILLING',
  'READY_FOR_REVIEW',
  'WAITING_APPROVAL',
  'READY_TO_SUBMIT',
];

/**
 * Loopback only. This is the hard boundary that keeps the browser framework away from any real
 * employer or ATS form: nothing but the local fake ATS can ever be a destination.
 */
export function isLoopbackOrigin(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return (
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host === 'localhost' ||
    host.endsWith('.localhost')
  );
}

function sameOrigin(rawUrl: string, origin: string): boolean {
  try {
    return new URL(rawUrl).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function refuse(code: string, message: string): ActionRefusal {
  return { ok: false, code, message };
}

function fieldFor(context: ValidationContext, fieldKey: string): MappedField | null {
  return context.mappedFields.find((field) => field.fieldKey === fieldKey) ?? null;
}

function guardAnswerAction(
  action: Extract<BrowserAction, { kind: 'fill' | 'select' | 'check' }>,
  context: ValidationContext,
): ActionCheck {
  const field = fieldFor(context, action.fieldKey);
  if (field === null) {
    return refuse(
      'field_not_in_inventory',
      'That control is not in the reviewed field inventory for this step.',
    );
  }
  if (field.humanOnly || field.sensitive) {
    return refuse(
      'human_only_field',
      'This field must be answered by the user; the agent may never fill it.',
    );
  }
  // An unrecognised control may still be filled, but only with an answer the user wrote for this
  // application. The agent may never supply one from the profile, because nothing maps to it.
  if (!isConfidentlyMapped(field) && action.source !== 'application_scoped_answer') {
    return refuse(
      'unmapped_field',
      'This control could not be mapped to a known question, so it must go to the user.',
    );
  }
  if (
    action.kind === 'fill' &&
    !['text', 'email', 'tel', 'number', 'textarea'].includes(field.controlType)
  ) {
    return refuse('control_type_mismatch', 'This control cannot be filled with typed text.');
  }
  if (action.kind === 'select' && field.controlType !== 'select') {
    return refuse('control_type_mismatch', 'This control is not a select menu.');
  }
  if (action.kind === 'check' && !['checkbox', 'radio'].includes(field.controlType)) {
    return refuse('control_type_mismatch', 'This control is not a checkbox or radio button.');
  }
  if (
    action.kind === 'select' &&
    field.options.length > 0 &&
    !field.options.includes(action.value)
  ) {
    return refuse('value_not_offered', 'That value is not one of the options the form offers.');
  }
  if (
    action.kind === 'check' &&
    field.controlType === 'radio' &&
    field.options.length > 0 &&
    (action.value === undefined || !field.options.includes(action.value))
  ) {
    return refuse('value_not_offered', 'That value is not one of the options the form offers.');
  }
  if (
    action.kind === 'fill' &&
    field.maxLength !== undefined &&
    action.value.length > field.maxLength
  ) {
    return refuse('value_too_long', 'The answer is longer than the form allows.');
  }
  if (action.source === 'approved_document') {
    return refuse('wrong_source', 'A document may only be supplied through an upload action.');
  }
  if (action.source === 'verified_fact' && action.evidenceFactIds.length === 0) {
    return refuse(
      'missing_evidence_reference',
      'An answer taken from the profile must name the verified fact it came from.',
    );
  }
  return { ok: true };
}

/**
 * Every action is checked against the workflow state, the adapter contract, the reviewed field
 * inventory, the site policy, the human-only rules and the submit guard before it can run.
 */
/**
 * Read through a boolean-typed parameter so the check still runs for a hand-built contract, not
 * only for one the schema has parsed.
 */
function targetsTheFakeAts(adapter: { isFakeTarget: boolean }): boolean {
  return adapter.isFakeTarget;
}

export function validateAction(action: BrowserAction, context: ValidationContext): ActionCheck {
  if (!targetsTheFakeAts(context.adapter)) {
    return refuse('target_not_fake_ats', 'Only the local fake ATS may be automated in this phase.');
  }
  if (!isLoopbackOrigin(context.adapter.targetOrigin)) {
    return refuse('target_not_loopback', 'The adapter target is not a local address.');
  }
  if (context.takeoverActive) {
    return refuse('manual_takeover', 'The user has taken over this application.');
  }
  if (context.paused && action.kind !== 'request_user') {
    return refuse('application_paused', 'This application is paused and waiting for the user.');
  }
  if (!statesThatMayAct.includes(context.workflowState)) {
    return refuse(
      'state_forbids_action',
      `No browser action is allowed in state ${context.workflowState}.`,
    );
  }

  if (action.kind === 'navigate') {
    if (!isLoopbackOrigin(action.url)) {
      return refuse(
        'destination_not_loopback',
        'Refusing to open anything other than the local fake ATS.',
      );
    }
    if (!sameOrigin(action.url, context.adapter.targetOrigin)) {
      return refuse('destination_off_adapter', 'That address is outside the fake ATS adapter.');
    }
    if (stepById(context.adapter, action.expectStepId) === null) {
      return refuse('unknown_step', 'That step is not part of the adapter contract.');
    }
    return { ok: true };
  }

  const step = stepById(context.adapter, action.stepId);
  if (step === null)
    return refuse('unknown_step', 'That step is not part of the adapter contract.');
  if (action.stepId !== context.currentStepId) {
    return refuse('step_mismatch', 'That action is for a different step than the one now open.');
  }
  if (step.humanOnly && action.kind !== 'request_user' && action.kind !== 'capture_review') {
    return refuse(
      'human_only_step',
      'This step is completed by the user: the agent may only ask for it.',
    );
  }

  switch (action.kind) {
    case 'fill':
    case 'select':
    case 'check':
      return guardAnswerAction(action, context);

    case 'upload': {
      const field = fieldFor(context, action.fieldKey);
      if (field?.controlType !== 'file') {
        return refuse('field_not_uploadable', 'That control does not accept a file.');
      }
      if (context.approvedDocument === null) {
        return refuse('no_approved_document', 'No approved CV is available to upload.');
      }
      if (action.documentId !== context.approvedDocument.documentId) {
        return refuse('document_not_approved', 'Only the approved CV may be uploaded.');
      }
      if (action.sha256 !== context.approvedDocument.sha256) {
        return refuse('document_hash_mismatch', 'The CV has changed since it was approved.');
      }
      return { ok: true };
    }

    case 'click_next': {
      if (step.nextSelector === undefined || step.nextSelector !== action.selector) {
        return refuse(
          'unexpected_navigation_control',
          'That is not the step control for this page.',
        );
      }
      return { ok: true };
    }

    case 'request_user':
    case 'capture_review':
      return { ok: true };

    case 'submit': {
      if (!context.sitePolicy.submitPermitted) {
        return refuse('site_policy_forbids_submit', 'The site policy does not permit submission.');
      }
      if (!isLoopbackOrigin(context.sitePolicy.origin)) {
        return refuse(
          'submit_target_not_loopback',
          'Submission is only ever permitted on the local fake ATS.',
        );
      }
      if (context.workflowState !== 'READY_TO_SUBMIT') {
        return refuse(
          'not_ready_to_submit',
          'The application is not in the ready-to-submit state.',
        );
      }
      if (step.submitSelector === undefined || step.submitSelector !== action.selector) {
        return refuse(
          'unexpected_submit_control',
          'That is not the final control for this adapter.',
        );
      }
      const guard = context.submitGuard;
      if (guard.activeIntentTokenHash === null || guard.snapshotHash === null) {
        return refuse('no_submit_intent', 'No submit intent has been issued.');
      }
      if (guard.consumed) {
        return refuse('submit_intent_consumed', 'That submit intent has already been used.');
      }
      if (guard.expiresAt !== null && new Date(guard.expiresAt) <= context.now) {
        return refuse('submit_intent_expired', 'The submit intent has expired.');
      }
      if (context.hashToken(action.intentToken) !== guard.activeIntentTokenHash) {
        return refuse(
          'submit_intent_mismatch',
          'That submit token does not match the issued intent.',
        );
      }
      if (action.snapshotHash !== guard.snapshotHash) {
        return refuse('snapshot_mismatch', 'The reviewed answers have changed since approval.');
      }
      return { ok: true };
    }
  }
}

export function validatePlan(
  actions: readonly BrowserAction[],
  context: ValidationContext,
): { ok: true } | { ok: false; index: number; refusal: ActionRefusal } {
  for (const [index, action] of actions.entries()) {
    const result = validateAction(action, context);
    if (!result.ok) return { ok: false, index, refusal: result };
  }
  return { ok: true };
}
