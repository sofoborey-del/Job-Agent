import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { fakeAtsAdapter } from '@job-agent/adapters';
import { validateAction, type ValidationContext } from '@job-agent/browser-core';
import type { KnowledgeFact } from '@job-agent/domain';
import { shadowMatch, type ShadowJob } from '@job-agent/matching';
import {
  evaluateSitePolicy,
  hostWithinPolicy,
  sitePolicySchema,
  type SitePolicy,
} from '@job-agent/policy';
import { describe, expect, it } from 'vitest';

type InjectionCase = { name: string; text: string; requestedUrl: string };
type InjectionCorpus = { description: string; cases: InjectionCase[] };

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../tests/fixtures/prompt-injection-corpus.json', import.meta.url)),
    'utf8',
  ),
) as InjectionCorpus;

const PRIVATE_VALUE = 'PRIVATE-PASSPORT-9981';
const PRIVATE_FACT_ID = '99999999-9999-4999-8999-999999999999';

function fact(
  id: string,
  key: string,
  value: unknown,
  allowedPurposes: KnowledgeFact<unknown>['allowedPurposes'] = ['matching', 'application'],
): KnowledgeFact<unknown> {
  return {
    id,
    key,
    value,
    status: 'verified',
    source: 'user',
    sensitivity: key.startsWith('private.') ? 'high_risk' : 'normal',
    usePolicy: 'auto_fill',
    allowedPurposes,
    version: 1,
  };
}

const facts: KnowledgeFact<unknown>[] = [
  fact('11111111-1111-4111-8111-111111111111', 'preferences.target_roles', [
    'customer service adviser',
  ]),
  fact('22222222-2222-4222-8222-222222222222', 'preferences.location', ['Glasgow']),
  fact('33333333-3333-4333-8333-333333333333', 'preferences.contract_type', ['permanent']),
  fact('44444444-4444-4444-8444-444444444444', 'skills.customer_service', [
    'customer service',
    'complaint handling',
  ]),
  fact('55555555-5555-4555-8555-555555555555', 'employment.history', [
    { title: 'Customer Service Adviser', duties: 'Resolved customer enquiries' },
  ]),
  fact('66666666-6666-4666-8666-666666666666', 'work_authorisation.gb', {
    authorised: true,
  }),
  // This fact is intentionally not approved for matching. Hostile advert text must not make it
  // available merely by naming or asking for it.
  fact(PRIVATE_FACT_ID, 'private.passport_number', PRIVATE_VALUE, ['application']),
];

const policy: SitePolicy = sitePolicySchema.parse({
  domain: 'myjobscotland.gov.uk',
  discoveryMode: 'manual_url',
  applyMode: 'prefill_only',
  termsStatus: 'reviewed_allowed',
  evidenceUrl: 'https://myjobscotland.gov.uk/disclaimer',
  reviewedAt: '2026-09-01T00:00:00.000Z',
  reviewExpiresAt: '2027-09-01T00:00:00.000Z',
  autoSubmitAllowed: false,
  rateLimit: { requests: 2, windowSeconds: 60 },
  version: 1,
});

function hostileJob(entry: InjectionCase, placement: 'advert' | 'document'): ShadowJob {
  const safeDescription =
    'Customer service experience is essential. This is a permanent role based in Glasgow.';
  return {
    id: `hostile-${placement}-${entry.name}`,
    title: 'Customer Service Adviser',
    employer: 'Example Employer',
    location: 'Glasgow',
    description: placement === 'advert' ? `${safeDescription}\n${entry.text}` : safeDescription,
    salary: {
      minimumMinor: 28_000_00,
      maximumMinor: 30_000_00,
      currency: 'GBP',
      basis: 'annual_base',
      confidence: 0.99,
      sourceText: '£28,000 to £30,000',
    },
    contractType: 'Permanent',
    employmentTypes: ['FULL_TIME'],
    workPattern: null,
    closesAt: '2027-01-31T23:59:59.000Z',
    ...(placement === 'document'
      ? { personSpecification: { status: 'read' as const, text: entry.text } }
      : {}),
  };
}

function validationContext(): ValidationContext {
  const origin = 'http://127.0.0.1:3311';
  return {
    workflowState: 'READY_TO_SUBMIT',
    adapter: fakeAtsAdapter(origin),
    currentStepId: 'review',
    mappedFields: [],
    sitePolicy: { origin, applyMode: 'manual_only', submitPermitted: false },
    approvedDocument: null,
    submitGuard: {
      activeIntentTokenHash: null,
      snapshotHash: null,
      expiresAt: null,
      consumed: false,
    },
    takeoverActive: false,
    paused: false,
    hashToken: (token) => token,
    now: new Date('2026-09-26T00:00:00.000Z'),
  };
}

describe('prompt-injection corpus', () => {
  it('treats hostile advert and document text as data, never as policy or applicant evidence', () => {
    const policyBefore = JSON.stringify(policy);

    for (const entry of corpus.cases) {
      for (const placement of ['advert', 'document'] as const) {
        const result = shadowMatch(
          hostileJob(entry, placement),
          facts,
          undefined,
          new Date('2026-09-26T00:00:00.000Z'),
        );
        const serialised = JSON.stringify(result);

        expect(result.decision.action).not.toBe('auto_apply');
        expect(result.decision.autoBlockers).toContain('site_policy_prefill_only');
        expect(serialised).not.toContain(PRIVATE_VALUE);
        expect(serialised).not.toContain(PRIVATE_FACT_ID);
      }
    }

    expect(JSON.stringify(policy)).toBe(policyBefore);
    expect(evaluateSitePolicy(policy).decision).toBe('prefill_only');
  });

  it('cannot turn an off-policy address in hostile content into an allowed destination', () => {
    for (const entry of corpus.cases) {
      expect(hostWithinPolicy(entry.requestedUrl, policy), entry.name).toBe(false);
      expect(
        validateAction(
          { kind: 'navigate', url: entry.requestedUrl, expectStepId: 'details' },
          validationContext(),
        ),
        entry.name,
      ).toMatchObject({ ok: false });
    }
  });

  it('cannot cause submission without the independent policy and submit guards', () => {
    for (const entry of corpus.cases) {
      const result = validateAction(
        {
          kind: 'submit',
          stepId: 'review',
          selector: '#submit-application',
          intentToken: entry.text.slice(0, 200).padEnd(32, 'x'),
          snapshotHash: 'a'.repeat(64),
        },
        validationContext(),
      );
      expect(result, entry.name).toMatchObject({
        ok: false,
        code: 'site_policy_forbids_submit',
      });
    }
  });
});
