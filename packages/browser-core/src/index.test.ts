import type { KnowledgeFact } from '@job-agent/domain';
import { describe, expect, it } from 'vitest';

import type { BrowserAction } from './actions.js';
import { adapterContractSchema, type AdapterContract } from './adapter.js';
import { advanceCheckpoint, checkpointStillValid, newCheckpoint } from './checkpoint.js';
import { mapField, mapInventory, type MappedField, type ObservedField } from './inventory.js';
import {
  compareManifests,
  hashAnswerValue,
  manifestHash,
  previewFor,
  type ReviewManifest,
} from './manifest.js';
import { redactText, sanitiseWorkerReport } from './redaction.js';
import { resolveAnswer } from './resolver.js';
import {
  checkSubmitEligibility,
  hashSubmitToken,
  issueSubmitIntent,
  submissionIdempotencyKey,
} from './submit-guard.js';
import { isLoopbackOrigin, validateAction, type ValidationContext } from './validator.js';

const adapter: AdapterContract = adapterContractSchema.parse({
  id: 'fake-ats',
  version: '2.0.0',
  targetOrigin: 'http://127.0.0.1:3311',
  allowsSubmit: true,
  isFakeTarget: true,
  confirmationPath: '/apply/:sessionId/confirmation',
  confirmationReferencePattern: '^FAKE-ATS-[A-Z0-9]{8}$',
  steps: [
    { id: 'details', path: '/apply/:sessionId/details', nextSelector: '#next', humanOnly: false },
    {
      id: 'questions',
      path: '/apply/:sessionId/questions',
      nextSelector: '#next',
      humanOnly: true,
    },
    {
      id: 'review',
      path: '/apply/:sessionId/review',
      submitSelector: '#submit-application',
      humanOnly: false,
    },
  ],
});

function observed(overrides: Partial<ObservedField> = {}): ObservedField {
  return {
    fieldKey: 'first_name',
    label: 'First name',
    controlType: 'text',
    selector: '[name="first_name"]',
    required: true,
    options: [],
    ...overrides,
  };
}

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    workflowState: 'FILLING',
    adapter,
    currentStepId: 'details',
    mappedFields: [mapField(observed())],
    sitePolicy: { origin: adapter.targetOrigin, applyMode: 'manual_only', submitPermitted: true },
    approvedDocument: null,
    submitGuard: {
      activeIntentTokenHash: null,
      snapshotHash: null,
      expiresAt: null,
      consumed: false,
    },
    takeoverActive: false,
    paused: false,
    hashToken: hashSubmitToken,
    now: new Date('2026-09-25T10:00:00.000Z'),
    ...overrides,
  };
}

const fillFirstName: BrowserAction = {
  kind: 'fill',
  stepId: 'details',
  fieldKey: 'first_name',
  selector: '[name="first_name"]',
  value: 'Alex',
  source: 'verified_fact',
  evidenceFactIds: ['11111111-1111-4111-8111-111111111111'],
};

/** Reads the one row a test expects, without a non-null assertion. */
function only<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}

describe('production targets are impossible', () => {
  it('only treats loopback addresses as usable', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:3311')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:3311/apply')).toBe(true);
    expect(isLoopbackOrigin('https://fake-ats.localhost/apply')).toBe(true);
    expect(isLoopbackOrigin('https://myjobscotland.gov.uk/apply')).toBe(false);
    expect(isLoopbackOrigin('https://www.linkedin.com/jobs/apply')).toBe(false);
    expect(isLoopbackOrigin('https://127.0.0.1.evil.test/apply')).toBe(false);
    expect(isLoopbackOrigin('file:///etc/passwd')).toBe(false);
  });

  it('refuses to navigate anywhere but the fake ATS', () => {
    for (const url of [
      'https://myjobscotland.gov.uk/apply/1',
      'https://www.indeed.com/apply',
      'https://careers.example.com/apply',
    ]) {
      const result = validateAction({ kind: 'navigate', url, expectStepId: 'details' }, context());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('destination_not_loopback');
    }
  });

  it('refuses a loopback address that is not this adapter', () => {
    const result = validateAction(
      { kind: 'navigate', url: 'http://127.0.0.1:9999/apply', expectStepId: 'details' },
      context(),
    );
    expect(result).toMatchObject({ ok: false, code: 'destination_off_adapter' });
  });

  it('refuses every action when the adapter is not the fake target', () => {
    const notFake = { ...adapter, isFakeTarget: false } as unknown as AdapterContract;
    const result = validateAction(fillFirstName, context({ adapter: notFake }));
    expect(result).toMatchObject({ ok: false, code: 'target_not_fake_ats' });
  });
});

describe('the action validator', () => {
  it('accepts a mapped, evidenced answer on the open step', () => {
    expect(validateAction(fillFirstName, context())).toEqual({ ok: true });
  });

  it('refuses a control that is not in the reviewed inventory', () => {
    const result = validateAction({ ...fillFirstName, fieldKey: 'not_seen' }, context());
    expect(result).toMatchObject({ ok: false, code: 'field_not_in_inventory' });
  });

  it('refuses an answer with no evidence reference', () => {
    const result = validateAction({ ...fillFirstName, evidenceFactIds: [] }, context());
    expect(result).toMatchObject({ ok: false, code: 'missing_evidence_reference' });
  });

  it('refuses to fill a sensitive or human-only control', () => {
    const disability = mapField(
      observed({
        fieldKey: 'disability',
        label: 'Do you consider yourself to have a disability?',
        controlType: 'radio',
        options: ['Yes', 'No'],
      }),
    );
    const result = validateAction(
      {
        kind: 'check',
        stepId: 'details',
        fieldKey: 'disability',
        selector: '[name="disability"]',
        checked: true,
        value: 'No',
        source: 'verified_fact',
        evidenceFactIds: ['11111111-1111-4111-8111-111111111111'],
      },
      context({ mappedFields: [disability] }),
    );
    expect(result).toMatchObject({ ok: false, code: 'human_only_field' });
  });

  it('refuses to fill an unrecognised control', () => {
    const unknown = mapField(
      observed({
        fieldKey: 'favourite_colour',
        label: 'Which colour best describes your working style?',
      }),
    );
    const result = validateAction(
      { ...fillFirstName, fieldKey: 'favourite_colour', selector: '[name="favourite_colour"]' },
      context({ mappedFields: [unknown] }),
    );
    expect(result).toMatchObject({ ok: false, code: 'unmapped_field' });
  });

  it('allows an unrecognised control to carry the answer the user wrote for it', () => {
    const unknown = mapField(
      observed({
        fieldKey: 'favourite_colour',
        label: 'Which colour best describes your working style?',
      }),
    );
    const base = context({ mappedFields: [unknown] });
    expect(
      validateAction(
        {
          ...fillFirstName,
          fieldKey: 'favourite_colour',
          selector: '[name="favourite_colour"]',
          source: 'application_scoped_answer',
          evidenceFactIds: [],
        },
        base,
      ),
    ).toEqual({ ok: true });
    // The same control still cannot be answered from the profile.
    expect(
      validateAction(
        { ...fillFirstName, fieldKey: 'favourite_colour', selector: '[name="favourite_colour"]' },
        base,
      ),
    ).toMatchObject({ ok: false, code: 'unmapped_field' });
  });

  it('refuses any filling action on a human-only step', () => {
    const result = validateAction(
      { ...fillFirstName, stepId: 'questions' },
      context({ currentStepId: 'questions' }),
    );
    expect(result).toMatchObject({ ok: false, code: 'human_only_step' });
  });

  it('refuses a value the form does not offer', () => {
    const select = mapField(
      observed({
        fieldKey: 'contract_preference',
        label: 'Contract type preference',
        controlType: 'select',
        options: ['Permanent', 'Fixed term'],
      }),
    );
    const result = validateAction(
      {
        kind: 'select',
        stepId: 'details',
        fieldKey: 'contract_preference',
        selector: '[name="contract_preference"]',
        value: 'Something else',
        source: 'verified_fact',
        evidenceFactIds: ['11111111-1111-4111-8111-111111111111'],
      },
      context({ mappedFields: [select] }),
    );
    expect(result).toMatchObject({ ok: false, code: 'value_not_offered' });
  });

  it('refuses everything while the user has taken over or the application is paused', () => {
    expect(validateAction(fillFirstName, context({ takeoverActive: true }))).toMatchObject({
      ok: false,
      code: 'manual_takeover',
    });
    expect(validateAction(fillFirstName, context({ paused: true }))).toMatchObject({
      ok: false,
      code: 'application_paused',
    });
  });

  it('only uploads the approved CV, unchanged', () => {
    const file = mapField(
      observed({ fieldKey: 'cv', label: 'Upload your CV', controlType: 'file', required: true }),
    );
    const approved = { documentId: '22222222-2222-4222-8222-222222222222', sha256: 'a'.repeat(64) };
    const base = context({ mappedFields: [file], approvedDocument: approved });
    const upload: BrowserAction = {
      kind: 'upload',
      stepId: 'details',
      fieldKey: 'cv',
      selector: '[name="cv"]',
      documentId: approved.documentId,
      sha256: approved.sha256,
    };
    expect(validateAction(upload, base)).toEqual({ ok: true });
    expect(validateAction({ ...upload, sha256: 'b'.repeat(64) }, base)).toMatchObject({
      ok: false,
      code: 'document_hash_mismatch',
    });
    expect(
      validateAction({ ...upload, documentId: '33333333-3333-4333-8333-333333333333' }, base),
    ).toMatchObject({ ok: false, code: 'document_not_approved' });
    expect(validateAction(upload, context({ mappedFields: [file] }))).toMatchObject({
      ok: false,
      code: 'no_approved_document',
    });
  });
});

describe('the submit guard', () => {
  const snapshotHash = 'c'.repeat(64);
  const intent = issueSubmitIntent({ snapshotHash, now: new Date('2026-09-25T10:00:00.000Z') });
  const submitContext = context({
    workflowState: 'READY_TO_SUBMIT',
    currentStepId: 'review',
    submitGuard: {
      activeIntentTokenHash: intent.tokenHash,
      snapshotHash,
      expiresAt: intent.expiresAt,
      consumed: false,
    },
  });
  const submit: BrowserAction = {
    kind: 'submit',
    stepId: 'review',
    selector: '#submit-application',
    intentToken: intent.token,
    snapshotHash,
  };

  it('permits exactly the approved snapshot with a live token', () => {
    expect(validateAction(submit, submitContext)).toEqual({ ok: true });
  });

  it('refuses a token that does not match, a used token, or an expired one', () => {
    expect(validateAction({ ...submit, intentToken: 'x'.repeat(40) }, submitContext)).toMatchObject(
      {
        ok: false,
        code: 'submit_intent_mismatch',
      },
    );
    expect(
      validateAction(
        submit,
        context({
          workflowState: 'READY_TO_SUBMIT',
          currentStepId: 'review',
          submitGuard: { ...submitContext.submitGuard, consumed: true },
        }),
      ),
    ).toMatchObject({ ok: false, code: 'submit_intent_consumed' });
    expect(
      validateAction(
        submit,
        context({
          workflowState: 'READY_TO_SUBMIT',
          currentStepId: 'review',
          submitGuard: submitContext.submitGuard,
          now: new Date('2026-09-25T11:00:00.000Z'),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'submit_intent_expired' });
  });

  it('refuses when the reviewed answers have changed', () => {
    expect(
      validateAction({ ...submit, snapshotHash: 'd'.repeat(64) }, submitContext),
    ).toMatchObject({
      ok: false,
      code: 'snapshot_mismatch',
    });
  });

  it('refuses when the workflow is not ready or the policy forbids it', () => {
    expect(validateAction(submit, context({ currentStepId: 'review' }))).toMatchObject({
      ok: false,
      code: 'not_ready_to_submit',
    });
    expect(
      validateAction(
        submit,
        context({
          workflowState: 'READY_TO_SUBMIT',
          currentStepId: 'review',
          sitePolicy: {
            origin: adapter.targetOrigin,
            applyMode: 'manual_only',
            submitPermitted: false,
          },
        }),
      ),
    ).toMatchObject({ ok: false, code: 'site_policy_forbids_submit' });
  });

  it('checks every eligibility clause before a final action', () => {
    const now = new Date('2026-09-25T10:00:00.000Z');
    const approval = {
      snapshotHash,
      decision: 'approved' as const,
      consumedAt: null,
      expiresAt: '2026-09-25T10:30:00.000Z',
    };
    const base = {
      workflowState: 'READY_TO_SUBMIT',
      targetOrigin: adapter.targetOrigin,
      isFakeTarget: true,
      approval,
      currentSnapshotHash: snapshotHash,
      outstandingQuestions: 0,
      ledgerStatus: 'none' as const,
      now,
    };
    expect(checkSubmitEligibility(base)).toEqual({ allowed: true });
    expect(checkSubmitEligibility({ ...base, isFakeTarget: false })).toMatchObject({
      reason: 'target_not_fake_ats',
    });
    expect(checkSubmitEligibility({ ...base, approval: null })).toMatchObject({
      reason: 'no_approval',
    });
    expect(
      checkSubmitEligibility({ ...base, approval: { ...approval, consumedAt: now.toISOString() } }),
    ).toMatchObject({ reason: 'approval_already_used' });
    expect(checkSubmitEligibility({ ...base, currentSnapshotHash: 'e'.repeat(64) })).toMatchObject({
      reason: 'snapshot_changed',
    });
    expect(checkSubmitEligibility({ ...base, outstandingQuestions: 1 })).toMatchObject({
      reason: 'questions_outstanding',
    });
    expect(checkSubmitEligibility({ ...base, ledgerStatus: 'reserved' })).toMatchObject({
      reason: 'already_submitted',
    });
    expect(checkSubmitEligibility({ ...base, ledgerStatus: 'unknown' })).toMatchObject({
      reason: 'awaiting_reconciliation',
    });
  });

  it('derives a stable idempotency key per application, attempt and snapshot', () => {
    const key = { applicationId: 'a', attemptId: 'b', snapshotHash };
    expect(submissionIdempotencyKey(key)).toBe(submissionIdempotencyKey(key));
    expect(submissionIdempotencyKey({ ...key, attemptId: 'c' })).not.toBe(
      submissionIdempotencyKey(key),
    );
  });
});

describe('the review manifest', () => {
  const manifest: ReviewManifest = {
    applicationId: 'app-1',
    attemptId: 'attempt-1',
    jobId: 'job-1',
    jobVersion: 1,
    adapterId: 'fake-ats',
    adapterVersion: '2.0.0',
    cvDocumentId: 'doc-1',
    cvSha256: 'a'.repeat(64),
    formFingerprints: [{ stepId: 'details', pageFingerprint: 'b'.repeat(64) }],
    answers: [
      {
        stepId: 'details',
        fieldKey: 'first_name',
        label: 'First name',
        intent: 'identity.first_name',
        answerHash: hashAnswerValue('Alex'),
        answerPreview: 'Alex',
        source: 'verified_fact',
        evidenceFactIds: ['fact-1'],
        sensitive: false,
        required: true,
      },
    ],
    outstandingQuestions: 0,
    createdAt: '2026-09-25T10:00:00.000Z',
  };

  it('is stable for the same content and changes with any material difference', () => {
    expect(manifestHash(manifest)).toBe(manifestHash({ ...manifest, createdAt: 'later' }));
    expect(manifestHash({ ...manifest, jobVersion: 2 })).not.toBe(manifestHash(manifest));
    expect(manifestHash({ ...manifest, adapterVersion: '2.0.1' })).not.toBe(manifestHash(manifest));
    expect(manifestHash({ ...manifest, cvSha256: 'c'.repeat(64) })).not.toBe(
      manifestHash(manifest),
    );
    expect(
      manifestHash({
        ...manifest,
        formFingerprints: [{ stepId: 'details', pageFingerprint: 'd'.repeat(64) }],
      }),
    ).not.toBe(manifestHash(manifest));
    const changedAnswer = {
      ...manifest,
      answers: [{ ...only(manifest.answers), answerHash: hashAnswerValue('Sam') }],
    };
    expect(manifestHash(changedAnswer)).not.toBe(manifestHash(manifest));
  });

  it('names what changed between two manifests', () => {
    const next = {
      ...manifest,
      cvSha256: 'c'.repeat(64),
      answers: [
        { ...only(manifest.answers), answerHash: hashAnswerValue('Sam') },
        {
          ...only(manifest.answers),
          fieldKey: 'late_addition',
          answerHash: null,
        },
      ],
    };
    const comparison = compareManifests(manifest, next);
    expect(comparison.same).toBe(false);
    expect(comparison.changed).toContain('cv_document');
    expect(comparison.changed).toContain('answer:details:first_name');
    expect(comparison.changed).toContain('added:details:late_addition');
  });

  it('never previews a sensitive value', () => {
    expect(previewFor('Yes', true)).toBeNull();
    expect(previewFor('Alex', false)).toBe('Alex');
  });
});

describe('the answer resolver', () => {
  const fact = (
    key: string,
    value: unknown,
    overrides: Partial<KnowledgeFact<unknown>> = {},
  ): KnowledgeFact<unknown> => ({
    id: '11111111-1111-4111-8111-111111111111',
    key,
    value,
    status: 'verified',
    source: 'user',
    sensitivity: 'normal',
    usePolicy: 'auto_fill',
    allowedPurposes: ['matching', 'application'],
    version: 1,
    ...overrides,
  });

  const field = (overrides: Partial<ObservedField> = {}): MappedField =>
    mapField(observed(overrides));

  it('uses a verified fact that allows application use', () => {
    const result = resolveAnswer({
      field: field(),
      facts: [fact('identity.first_name', 'Alex')],
      applicationAnswers: [],
    });
    expect(result).toMatchObject({ status: 'resolved', value: 'Alex', source: 'verified_fact' });
  });

  it('pauses when the profile has nothing for the question', () => {
    expect(resolveAnswer({ field: field(), facts: [], applicationAnswers: [] })).toMatchObject({
      status: 'requires_user',
      reason: 'missing_evidence',
    });
  });

  it('pauses on an expired, unverified or restricted fact rather than using it', () => {
    expect(
      resolveAnswer({
        field: field(),
        facts: [fact('identity.first_name', 'Alex', { expiresAt: '2020-01-01T00:00:00.000Z' })],
        applicationAnswers: [],
      }),
    ).toMatchObject({ reason: 'expired_fact' });
    expect(
      resolveAnswer({
        field: field(),
        facts: [fact('identity.first_name', 'Alex', { status: 'unverified' })],
        applicationAnswers: [],
      }),
    ).toMatchObject({ reason: 'unverified_fact' });
    expect(
      resolveAnswer({
        field: field(),
        facts: [fact('identity.first_name', 'Alex', { usePolicy: 'ask_each_time' })],
        applicationAnswers: [],
      }),
    ).toMatchObject({ reason: 'use_policy_forbids' });
    expect(
      resolveAnswer({
        field: field(),
        facts: [fact('identity.first_name', 'Alex', { sensitivity: 'high_risk' })],
        applicationAnswers: [],
      }),
    ).toMatchObject({ reason: 'sensitive_question' });
  });

  it('pauses on an unrecognised question and never invents an answer', () => {
    expect(
      resolveAnswer({
        field: field({
          fieldKey: 'favourite_colour',
          label: 'Which colour best describes your working style?',
        }),
        facts: [fact('identity.first_name', 'Alex')],
        applicationAnswers: [],
      }),
    ).toMatchObject({ status: 'requires_user', reason: 'unknown_field' });
  });

  it('pauses on a sensitive question even when a fact exists', () => {
    expect(
      resolveAnswer({
        field: field({
          fieldKey: 'disability',
          label: 'Do you consider yourself to have a disability?',
          controlType: 'radio',
        }),
        facts: [fact('identity.first_name', 'Alex')],
        applicationAnswers: [],
      }),
    ).toMatchObject({ status: 'requires_user', reason: 'sensitive_question' });
  });

  it('uses an answer the user gave for this application', () => {
    expect(
      resolveAnswer({
        field: field({
          fieldKey: 'favourite_colour',
          label: 'Which colour best describes your working style?',
        }),
        facts: [],
        applicationAnswers: [
          { fieldKey: 'favourite_colour', value: 'Blue', answeredAt: '2026-09-25T10:00:00.000Z' },
        ],
      }),
    ).toMatchObject({ status: 'resolved', value: 'Blue', source: 'application_scoped_answer' });
  });
});

describe('mapping', () => {
  it('recognises the supported questions and leaves the rest unknown', () => {
    const mapped = mapInventory({
      stepId: 'details',
      url: 'http://127.0.0.1:3311/apply/x/details',
      pageFingerprint: 'a'.repeat(64),
      fields: [
        observed(),
        observed({ fieldKey: 'email', label: 'Email address', controlType: 'email' }),
        observed({
          fieldKey: 'favourite_colour',
          label: 'Which colour best describes your working style?',
        }),
        observed({
          fieldKey: 'declaration',
          label: 'I declare that the information given is true and complete',
          controlType: 'checkbox',
        }),
      ],
      validationMessages: [],
      humanOnlyMarkers: [],
    });
    expect(mapped.map((field) => field.intent)).toEqual([
      'identity.first_name',
      'contact.email',
      'unknown',
      'declaration.truth',
    ]);
    expect(mapped[3]?.humanOnly).toBe(true);
  });
});

describe('checkpoints', () => {
  const now = new Date('2026-09-25T10:00:00.000Z');
  const checkpoint = newCheckpoint({
    attemptId: '44444444-4444-4444-8444-444444444444',
    adapterId: 'fake-ats',
    adapterVersion: '2.0.0',
    currentStepId: 'details',
    currentUrl: 'http://127.0.0.1:3311/apply/x/details',
    pageFingerprint: 'a'.repeat(64),
    now,
  });

  it('accumulates completed steps and field hashes', () => {
    const next = advanceCheckpoint(checkpoint, {
      completedStepIds: ['details'],
      fieldHashes: { 'details:first_name': 'b'.repeat(64) },
    });
    expect(next.completedStepIds).toEqual(['details']);
    expect(Object.keys(next.fieldHashes)).toEqual(['details:first_name']);
  });

  it('refuses to resume onto a changed form, a changed adapter or an expired checkpoint', () => {
    expect(
      checkpointStillValid(
        checkpoint,
        { adapterVersion: '2.0.0', stepId: 'details', pageFingerprint: 'a'.repeat(64) },
        now,
      ),
    ).toEqual({ ok: true });
    expect(
      checkpointStillValid(
        checkpoint,
        { adapterVersion: '2.0.1', stepId: 'details', pageFingerprint: 'a'.repeat(64) },
        now,
      ),
    ).toMatchObject({ reason: 'adapter_version_changed' });
    expect(
      checkpointStillValid(
        checkpoint,
        { adapterVersion: '2.0.0', stepId: 'details', pageFingerprint: 'c'.repeat(64) },
        now,
      ),
    ).toMatchObject({ reason: 'form_changed' });
    expect(
      checkpointStillValid(
        checkpoint,
        { adapterVersion: '2.0.0', stepId: 'details', pageFingerprint: 'a'.repeat(64) },
        new Date('2026-09-27T10:00:00.000Z'),
      ),
    ).toMatchObject({ reason: 'checkpoint_expired' });
  });

  it('never stores an applicant value', () => {
    expect(JSON.stringify(checkpoint)).not.toContain('Alex');
    expect(Object.keys(checkpoint)).not.toContain('values');
  });
});

describe('redaction', () => {
  it('removes applicant values from anything that leaves the worker', () => {
    const text = redactText(
      'Supporting statement must not contain Alexander Smith or 07700900123',
      {
        secrets: ['Alexander Smith', '07700900123'],
      },
    );
    expect(text).not.toContain('Alexander Smith');
    expect(text).not.toContain('07700900123');
  });

  it('strips forbidden keys from a worker report', () => {
    const report = sanitiseWorkerReport({
      attemptId: 'a',
      cookies: [{ name: 'session' }],
      storageState: { origins: [] },
      html: '<html>Alex</html>',
      pageText: 'Alex',
      values: { first_name: 'Alex' },
      inventory: { stepId: 'details' },
    });
    expect(Object.keys(report).sort()).toEqual(['attemptId', 'inventory']);
    expect(JSON.stringify(report)).not.toContain('Alex');
  });
});
