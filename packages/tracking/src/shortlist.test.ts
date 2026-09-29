import { describe, expect, it } from 'vitest';

import {
  assessShortlistEntry,
  groupByShortlistBand,
  shortlistBandOrder,
  type ShortlistBand,
} from './shortlist.js';
import type { MatchExplanation } from './types.js';

/**
 * The replacement for a score that did not separate anything.
 *
 * The property worth protecting is that no band depends on a tunable number. Every one is decided by
 * whether a count is zero, which is why this can ship without a versioned-configuration decision
 * about thresholds — there is no threshold to decide.
 */

type Outcome = MatchExplanation['requirements'][number]['outcome'];

function explanation(input: {
  outcomes?: Outcome[];
  hardRejectReasons?: string[];
  autoBlockers?: string[];
}): MatchExplanation {
  return {
    hardRejectReasons: input.hardRejectReasons ?? [],
    autoBlockers: input.autoBlockers ?? [],
    explanation: [],
    signals: {},
    requirements: (input.outcomes ?? []).map((outcome, index) => ({
      key: `requirement-${String(index)}`,
      text: `Requirement ${String(index)}`,
      outcome,
      confidence: 0.5,
      explanation: '',
      evidenceFactIds: [],
    })),
  };
}

describe('what the agent could establish', () => {
  it('counts what it checked, and reports coverage without banding on it', () => {
    const assessment = assessShortlistEntry({
      explanation: explanation({ outcomes: ['met', 'met', 'not_met', 'unknown'] }),
    });
    expect(assessment).toMatchObject({
      band: 'partly_checked',
      criteriaSeen: 4,
      criteriaChecked: 3,
      criteriaMet: 2,
      criteriaNotMet: 1,
      criteriaUnknown: 1,
      coverage: 0.75,
    });
    expect(assessment.summary).toContain('3 of 4 requirements checked');
  });

  it('calls it fully checked only when nothing was left unjudged', () => {
    expect(
      assessShortlistEntry({ explanation: explanation({ outcomes: ['met', 'not_met'] }) }).band,
    ).toBe('fully_checked');
  });

  it('hands a vacancy back when it read the requirements and could judge none', () => {
    const assessment = assessShortlistEntry({
      explanation: explanation({ outcomes: ['unknown', 'unknown', 'unknown'] }),
    });
    expect(assessment.band).toBe('yours_to_judge');
    expect(assessment.coverage).toBe(0);
    expect(assessment.summary).toContain('none could be checked against your profile');
  });

  it('says plainly when no requirements were established at all', () => {
    const assessment = assessShortlistEntry({ explanation: explanation({}) });
    expect(assessment.band).toBe('criteria_unseen');
    expect(assessment.summary).toContain('No requirements could be read');
  });

  it('explains an excerpt-only lead differently, because the fix is different', () => {
    const assessment = assessShortlistEntry({
      explanation: explanation({}),
      descriptionCompleteness: 'snippet',
    });
    expect(assessment.band).toBe('criteria_unseen');
    expect(assessment.summary).toContain('Only an excerpt');
  });

  it('treats a job that was never scored as unseen rather than guessing', () => {
    expect(assessShortlistEntry({ explanation: null }).band).toBe('criteria_unseen');
  });

  it('does not count a requirement it judged not applicable as a gap', () => {
    const assessment = assessShortlistEntry({
      explanation: explanation({ outcomes: ['met', 'not_applicable'] }),
    });
    expect(assessment.criteriaSeen).toBe(1);
    expect(assessment.band).toBe('fully_checked');
  });
});

describe('a hard gate outranks everything the evidence says', () => {
  it('blocks an internal-only vacancy however well its criteria were checked', () => {
    const assessment = assessShortlistEntry({
      explanation: explanation({
        outcomes: ['met', 'met', 'met'],
        hardRejectReasons: ['restricted_to_internal_candidates'],
      }),
    });
    expect(assessment.band).toBe('blocked');
    expect(assessment.blockedBy).toBe('restricted_to_internal_candidates');
    expect(assessment.summary).toContain('existing staff');
    // The counts are still reported: the person may want to know it would otherwise have suited.
    expect(assessment.criteriaMet).toBe(3);
  });

  it('names any other hard gate in plain words', () => {
    const assessment = assessShortlistEntry({
      explanation: explanation({ outcomes: ['met'], hardRejectReasons: ['salary_below_minimum'] }),
    });
    expect(assessment.band).toBe('blocked');
    expect(assessment.summary).toContain('salary below minimum');
  });

  it('carries the reasons nothing automatic may happen', () => {
    expect(
      assessShortlistEntry({
        explanation: explanation({ outcomes: ['met'], autoBlockers: ['advert_text_truncated'] }),
      }).autoBlockers,
    ).toEqual(['advert_text_truncated']);
  });
});

describe('no band depends on a number anyone chose', () => {
  it('moves between bands only as a count crosses zero', () => {
    const bandFor = (outcomes: Outcome[]): ShortlistBand =>
      assessShortlistEntry({ explanation: explanation({ outcomes }) }).band;

    // One unknown among ninety-nine checked is still "partly", and one checked among ninety-nine
    // unknowns is still "partly". Nothing here is a proportion, so nothing can be tuned.
    expect(bandFor([...Array<Outcome>(99).fill('met'), 'unknown'])).toBe('partly_checked');
    expect(bandFor([...Array<Outcome>(99).fill('unknown'), 'met'])).toBe('partly_checked');
    expect(bandFor(Array<Outcome>(99).fill('unknown'))).toBe('yours_to_judge');
    expect(bandFor(Array<Outcome>(99).fill('met'))).toBe('fully_checked');
  });
});

describe('reading order', () => {
  it('puts the vacancies worth reading first and the blocked ones last', () => {
    expect(shortlistBandOrder.fully_checked).toBeLessThan(shortlistBandOrder.partly_checked);
    expect(shortlistBandOrder.partly_checked).toBeLessThan(shortlistBandOrder.yours_to_judge);
    expect(shortlistBandOrder.yours_to_judge).toBeLessThan(shortlistBandOrder.criteria_unseen);
    expect(shortlistBandOrder.criteria_unseen).toBeLessThan(shortlistBandOrder.blocked);
  });

  it('groups without re-ordering anything inside a group', () => {
    const entries = [
      { id: 'a', band: 'blocked' as ShortlistBand },
      { id: 'b', band: 'yours_to_judge' as ShortlistBand },
      { id: 'c', band: 'blocked' as ShortlistBand },
      { id: 'd', band: 'fully_checked' as ShortlistBand },
      { id: 'e', band: 'yours_to_judge' as ShortlistBand },
    ];
    const groups = groupByShortlistBand(entries, (entry) => entry.band);
    expect(groups.map((group) => group.band)).toEqual([
      'fully_checked',
      'yours_to_judge',
      'blocked',
    ]);
    expect(groups[1]?.entries.map((entry) => entry.id)).toEqual(['b', 'e']);
    expect(groups[2]?.entries.map((entry) => entry.id)).toEqual(['a', 'c']);
  });

  it('returns nothing for an empty list rather than empty groups', () => {
    expect(groupByShortlistBand([], () => 'blocked')).toEqual([]);
  });
});
