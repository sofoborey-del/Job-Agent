import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { KnowledgeFact } from '@job-agent/domain';
import { describe, expect, it } from 'vitest';

import { shadowMatch, type ShadowJob } from './shadow.js';

type Corpus = {
  profileFacts: Array<{ id: string; key: string; value: unknown }>;
  cases: Array<{ name: string; note: string; job: ShadowJob }>;
};

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../tests/fixtures/shadow-corpus.json', import.meta.url)),
    'utf8',
  ),
) as Corpus;

const facts: KnowledgeFact<unknown>[] = corpus.profileFacts.map((fact) => ({
  id: fact.id,
  key: fact.key,
  value: fact.value,
  status: 'verified',
  source: 'user',
  sensitivity: 'normal',
  usePolicy: 'auto_fill',
  allowedPurposes: ['matching', 'application'],
  version: 1,
}));

const now = new Date('2026-09-25T00:00:00.000Z');

/**
 * An advert whose page carries no criteria at all. This is the real MyJobScotland shape that started
 * the problem: the summary is on the page and the person specification is in a linked document.
 */
const thinAdvert: ShadowJob = {
  id: 'thin-1',
  title: 'Information Governance Adviser',
  employer: 'A Council',
  location: 'Glasgow',
  description:
    'An opportunity has arisen within our team. Please see the attached documents for full details of the post and how to apply.',
  salary: {
    minimumMinor: 3_600_000,
    maximumMinor: 4_200_000,
    currency: 'GBP',
    basis: 'annual_base',
    confidence: 0.99,
    sourceText: '£36,000 - £42,000 per year',
  },
  contractType: 'Permanent',
  employmentTypes: ['FULL_TIME'],
  workPattern: null,
  closesAt: '2026-12-31T00:00:00.000Z',
};

const specificationText = [
  'Membership of the PVG Scheme is essential for this post.',
  'Experience of records management and information governance is essential.',
  'Knowledge of data protection legislation is required.',
  'A relevant professional qualification is essential.',
].join('\n');

describe('criteria that live in a linked document', () => {
  it('finds no essential requirements when the page text carries none', () => {
    const result = shadowMatch(thinAdvert, facts, undefined, now);
    expect(result.requirements).toHaveLength(0);
    expect(result.criteria.visible).toBe(false);
    expect(result.criteria.personSpecification).toBe('absent');
  });

  it('says plainly that nothing was checked, instead of looking confident', () => {
    const result = shadowMatch(thinAdvert, facts, undefined, now);
    // The bug this replaces: zero requirements read as "nothing to satisfy".
    expect(result.decision.autoBlockers).toContain('no_mandatory_criteria_visible');
  });

  it('extracts the real requirements once the linked document has been read', () => {
    const result = shadowMatch(
      { ...thinAdvert, personSpecification: { status: 'read', text: specificationText } },
      facts,
      undefined,
      now,
    );
    expect(result.criteria.personSpecification).toBe('read');
    expect(result.criteria.fromAdvertText).toBe(0);
    expect(result.criteria.fromPersonSpecification).toBeGreaterThanOrEqual(3);
    expect(result.criteria.visible).toBe(true);
    expect(result.decision.autoBlockers).not.toContain('no_mandatory_criteria_visible');
    expect(
      result.requirements.every((requirement) => requirement.source === 'person_specification'),
    ).toBe(true);
  });

  it('surfaces a PVG requirement it cannot evidence, rather than treating it as met', () => {
    const result = shadowMatch(
      { ...thinAdvert, personSpecification: { status: 'read', text: specificationText } },
      facts,
      undefined,
      now,
    );
    const pvg = result.requirements.find((requirement) => /PVG/i.test(requirement.text));
    expect(pvg).toBeDefined();
    expect(pvg?.outcome).toBe('unknown');
    expect(result.decision.autoBlockers).toContain(`mandatory_unknown:${pvg?.id ?? ''}`);
  });

  it('does not double count a requirement that appears in both the page and the document', () => {
    const shared = 'Experience of records management is essential.';
    const result = shadowMatch(
      {
        ...thinAdvert,
        description: `${thinAdvert.description}\n${shared}`,
        personSpecification: { status: 'read', text: `${shared}\n${specificationText}` },
      },
      facts,
      undefined,
      now,
    );
    const occurrences = result.requirements.filter(
      (requirement) => requirement.text === shared,
    ).length;
    expect(occurrences).toBe(1);
  });

  it('blocks automatic progression when a linked document could not be read', () => {
    const result = shadowMatch(
      {
        ...thinAdvert,
        personSpecification: { status: 'unreadable', reason: 'malware_detected' },
      },
      facts,
      undefined,
      now,
    );
    expect(result.criteria.personSpecification).toBe('unreadable');
    expect(result.criteria.unreadableReason).toBe('malware_detected');
    expect(result.decision.autoBlockers).toContain('person_specification_unreadable');
  });

  it('keeps a role visible rather than rejecting it on a score that missed the criteria', () => {
    const poorScoring: ShadowJob = {
      ...thinAdvert,
      title: 'Kitchen Porter',
      description: 'Please see the attached documents.',
    };
    const rejected = shadowMatch(poorScoring, facts, undefined, now);
    expect(rejected.decision.action).toBe('reject');

    const unreadable = shadowMatch(
      {
        ...poorScoring,
        personSpecification: { status: 'unreadable', reason: 'attachment_http_error' },
      },
      facts,
      undefined,
      now,
    );
    // Same score, but the agent knows it never saw the criteria, so it asks rather than discards.
    expect(unreadable.decision.score).toBe(rejected.decision.score);
    expect(unreadable.decision.action).toBe('shortlist');
    expect(unreadable.decision.autoBlockers).toContain('person_specification_unreadable');
  });

  it('still hard rejects a closed vacancy, whatever the criteria state', () => {
    const closed = shadowMatch(
      {
        ...thinAdvert,
        closesAt: '2025-01-01T00:00:00.000Z',
        personSpecification: { status: 'unreadable', reason: 'attachment_http_error' },
      },
      facts,
      undefined,
      now,
    );
    expect(closed.decision.action).toBe('reject');
    expect(closed.decision.hardRejectReasons).toContain('job_not_open');
  });

  it('still hard rejects a salary below the floor, whatever the criteria state', () => {
    const underpaid = shadowMatch(
      {
        ...thinAdvert,
        salary: {
          minimumMinor: 1_800_000,
          maximumMinor: 2_000_000,
          currency: 'GBP',
          basis: 'annual_base',
          confidence: 0.99,
          sourceText: '£18,000 - £20,000 per year',
        },
        personSpecification: { status: 'unreadable', reason: 'attachment_http_error' },
      },
      facts,
      undefined,
      now,
    );
    expect(underpaid.decision.action).toBe('reject');
    expect(underpaid.decision.hardRejectReasons).toContain('salary_below_floor');
  });

  it('never recommends an automatic application, whatever the criteria state', () => {
    for (const specification of [
      undefined,
      { status: 'read' as const, text: specificationText },
      { status: 'unreadable' as const, reason: 'scan_unavailable' },
      { status: 'absent' as const },
    ]) {
      const result = shadowMatch(
        specification === undefined
          ? thinAdvert
          : { ...thinAdvert, personSpecification: specification },
        facts,
        undefined,
        now,
      );
      expect(result.decision.action).not.toBe('auto_apply');
    }
  });

  it('keeps the same decision for the same inputs', () => {
    const job: ShadowJob = {
      ...thinAdvert,
      personSpecification: { status: 'read', text: specificationText },
    };
    const first = shadowMatch(job, facts, undefined, now);
    const second = shadowMatch(job, facts, undefined, now);
    expect(second.decision).toEqual(first.decision);
    expect(second.requirements).toEqual(first.requirements);
  });
});
