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

function caseNamed(name: string): ShadowJob {
  const entry = corpus.cases.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`The shadow corpus has no case named ${name}`);
  return entry.job;
}

describe('shadow corpus', () => {
  it('never recommends an automatic application anywhere in the corpus', () => {
    for (const entry of corpus.cases) {
      const result = shadowMatch(entry.job, facts, undefined, now);
      expect(result.decision.action).not.toBe('auto_apply');
    }
  });

  it('hard rejects a salary maximum below the floor', () => {
    const result = shadowMatch(caseNamed('salary clearly below the floor'), facts, undefined, now);
    expect(result.salaryGate).toBe('reject');
    expect(result.decision.action).toBe('reject');
    expect(result.decision.hardRejectReasons).toContain('salary_below_floor');
  });

  it('leaves an unstated, straddling or hourly salary as unknown and blocks automatic progress', () => {
    for (const name of [
      'ambiguous salary, negotiable',
      'salary range straddling the floor',
      'hourly pay only',
    ]) {
      const result = shadowMatch(caseNamed(name), facts, undefined, now);
      expect(result.salaryGate).toBe('unknown');
      expect(result.decision.autoBlockers).toContain('salary_unknown');
    }
  });

  it('keeps an unevidenced mandatory requirement as unknown rather than treating it as met', () => {
    const result = shadowMatch(caseNamed('missing mandatory prerequisite'), facts, undefined, now);
    const pvg = result.requirements.find((requirement) => /PVG/i.test(requirement.text));
    expect(pvg?.outcome).toBe('unknown');
    expect(pvg?.evidenceFactIds).toEqual([]);
    expect(
      result.decision.autoBlockers.some((blocker) => blocker.startsWith('mandatory_unknown')),
    ).toBe(true);
  });

  it('hard rejects a closed vacancy and an advert the user excluded', () => {
    expect(
      shadowMatch(caseNamed('closed vacancy'), facts, undefined, now).decision.hardRejectReasons,
    ).toContain('job_not_open');
    expect(
      shadowMatch(caseNamed("excluded by the user's own rule"), facts, undefined, now).decision
        .hardRejectReasons,
    ).toContain('user_exclusion_rule');
  });

  it('scores a close match above an unrelated trade role', () => {
    const strong = shadowMatch(caseNamed('strong match, clear salary'), facts, undefined, now);
    const weak = shadowMatch(caseNamed('poor match, unrelated trade role'), facts, undefined, now);
    expect(strong.decision.score).toBeGreaterThan(weak.decision.score);
    expect(strong.decision.action).not.toBe('reject');
  });

  // A good role must not disappear merely because it names a licence the profile cannot evidence.
  // The requirement still blocks everything automatic; it must not hide the advert from the user.
  it('keeps a good match visible when its only gap is an unevidenced licence', () => {
    const blocked = shadowMatch(
      caseNamed('strong match blocked only by a licence'),
      facts,
      undefined,
      now,
    );
    expect(blocked.decision.action).not.toBe('reject');
    expect(blocked.decision.hardRejectReasons).toEqual([]);
    expect(
      blocked.decision.autoBlockers.some((blocker) => blocker.startsWith('mandatory_unknown')),
    ).toBe(true);

    // It costs the advert some score, but nothing like enough to drop it out of sight.
    const clean = shadowMatch(caseNamed('strong match, clear salary'), facts, undefined, now);
    expect(clean.decision.score - blocked.decision.score).toBeLessThan(25);
  });
});
