import { describe, expect, it } from 'vitest';

import type { KnowledgeFact } from '@job-agent/domain';

import { findMissingProfileCategories, resolveFact, validateClaimsAreGrounded } from './index.js';

const verifiedFact: KnowledgeFact<string> = {
  id: 'fact-1',
  key: 'skills.customer_service',
  value: 'Customer service',
  status: 'verified',
  source: 'user',
  sourceRef: 'confirmation-1',
  verifiedAt: '2026-09-20T10:00:00.000Z',
  sensitivity: 'normal',
  usePolicy: 'auto_fill',
  allowedPurposes: ['matching', 'application'],
  version: 1,
};

describe('knowledge fact resolution', () => {
  it('resolves an active, verified, purpose-compatible fact', () => {
    expect(resolveFact(verifiedFact, 'application', new Date('2026-09-24T00:00:00Z'))).toEqual({
      status: 'resolved',
      factId: 'fact-1',
      value: 'Customer service',
    });
  });

  it('requires the user for expired, high-risk, or ask-each-time values', () => {
    expect(
      resolveFact(
        { ...verifiedFact, expiresAt: '2026-09-23T00:00:00.000Z' },
        'application',
        new Date('2026-09-24T00:00:00Z'),
      ),
    ).toMatchObject({ status: 'requires_user', reason: 'fact_expired' });
    expect(resolveFact({ ...verifiedFact, sensitivity: 'high_risk' }, 'application')).toMatchObject(
      { status: 'requires_user', reason: 'high_risk_value' },
    );
    expect(
      resolveFact({ ...verifiedFact, usePolicy: 'ask_each_time' }, 'application'),
    ).toMatchObject({ status: 'requires_user', reason: 'ask_each_time' });
  });

  it('never treats an unverified value as an application answer', () => {
    expect(resolveFact({ ...verifiedFact, status: 'unverified' }, 'application')).toMatchObject({
      status: 'requires_user',
      reason: 'fact_unverified',
    });
  });
});

describe('claim grounding', () => {
  it('accepts claims backed by resolvable verified facts', () => {
    const facts = new Map<string, KnowledgeFact<unknown>>([['fact-1', verifiedFact]]);
    expect(
      validateClaimsAreGrounded(
        [{ text: 'Experienced in customer service.', evidenceFactIds: ['fact-1'] }],
        facts,
      ),
    ).toEqual({ grounded: true });
  });

  it('rejects claims with absent or unverified evidence', () => {
    const facts = new Map<string, KnowledgeFact<unknown>>([
      ['fact-1', { ...verifiedFact, status: 'unverified' }],
    ]);
    const result = validateClaimsAreGrounded(
      [
        { text: 'Unsupported claim.', evidenceFactIds: [] },
        { text: 'Unverified claim.', evidenceFactIds: ['fact-1'] },
      ],
      facts,
    );
    expect(result).toMatchObject({ grounded: false, unsupportedClaimIndexes: [0, 1] });
  });
});

describe('profile completeness', () => {
  it('reports missing required fact categories without exposing values', () => {
    const missing = findMissingProfileCategories([
      {
        ...verifiedFact,
        id: 'identity-1',
        key: 'identity.legal_name.given',
        value: 'Synthetic',
      },
    ]);
    expect(missing).not.toContain('identity.');
    expect(missing).toContain('contact.');
    expect(missing).toContain('documents.cv');
  });
});
