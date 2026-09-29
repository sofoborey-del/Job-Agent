import type { MatchExplanation } from './types.js';

/**
 * What the agent could actually establish about a vacancy, instead of a score.
 *
 * Why this exists. The 2026-09-29 review measured the shortlist against ten real adverts and found
 * that 86 of 100 extracted criteria resolve to `unknown`: the agent reads a person specification
 * correctly and then cannot evidence prose like "significant experience within Organisational
 * Development" against a structured profile. Every score landed between 37 and 54, so the numbers
 * did not separate the adverts, and every rejection was a hard gate rather than a score. A shortlist
 * where everything sits in a 17-point band is not ranking, and presenting it as a ranking invites the
 * person to trust an ordering that does not exist.
 *
 * So this replaces the headline number with a statement of what was checked. It is not a second
 * score and it is not a threshold: **every band is decided by whether a count is zero or not.**
 * There is no tunable boundary anywhere in this file, which is deliberate — this project's standing
 * instruction is that scoring thresholds and weightings are decided through versioned configuration
 * rather than tuned in passing, and a presentation band chosen by taste would be exactly that in
 * disguise. The score is still recorded and still shown; it simply stops being the thing that
 * answers "should I look at this?".
 */

export const shortlistBands = [
  /** A hard gate failed. No amount of profile evidence can change it. */
  'blocked',
  /** Every extracted requirement was checked against the profile. */
  'fully_checked',
  /** Some requirements were checked and some could not be. */
  'partly_checked',
  /** Requirements were read, and not one of them could be checked. The person must judge. */
  'yours_to_judge',
  /** No requirements were established at all, so nothing has been checked. */
  'criteria_unseen',
] as const;
export type ShortlistBand = (typeof shortlistBands)[number];

/**
 * Reading order, worst last. `fully_checked` first because those are the only vacancies where the
 * agent's opinion is worth anything; `blocked` last because there is nothing to do with them.
 */
export const shortlistBandOrder: Readonly<Record<ShortlistBand, number>> = {
  fully_checked: 0,
  partly_checked: 1,
  yours_to_judge: 2,
  criteria_unseen: 3,
  blocked: 4,
};

export const shortlistBandLabels: Readonly<Record<ShortlistBand, string>> = {
  fully_checked: 'Checked against your profile',
  partly_checked: 'Partly checked',
  yours_to_judge: 'Yours to judge',
  criteria_unseen: 'Requirements never read',
  blocked: 'Blocked',
};

export type ShortlistAssessment = {
  band: ShortlistBand;
  /** Plain English, written for the person rather than the log. */
  summary: string;
  /** Requirements the agent established from the advert or its criteria document. */
  criteriaSeen: number;
  /** Of those, how many it could judge either way. This is the honest measure of its usefulness. */
  criteriaChecked: number;
  criteriaMet: number;
  criteriaNotMet: number;
  criteriaUnknown: number;
  /** checked / seen, rounded to two places. Reported, never used to decide a band. */
  coverage: number;
  /** The gate that blocks this vacancy, when one does. */
  blockedBy: string | null;
  /** Reasons nothing automatic may happen, carried through for display. */
  autoBlockers: readonly string[];
};

export type ShortlistAssessmentInput = {
  explanation: MatchExplanation | null;
  /** 'snippet' means only an aggregator excerpt was ever read. */
  descriptionCompleteness?: 'full' | 'snippet';
  /** Set when the advert itself is no longer worth acting on. */
  lifecycleStatus?: string;
};

function readable(reason: string): string {
  return reason.replace(/_/g, ' ');
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The unscored assessment, derived entirely from a recorded match run. */
export function assessShortlistEntry(input: ShortlistAssessmentInput): ShortlistAssessment {
  const explanation = input.explanation;
  const requirements = explanation?.requirements ?? [];
  // `not_applicable` is neither a pass nor a gap, so it counts as neither seen nor checked: the
  // agent decided the requirement does not apply, and reporting it as a gap would overstate risk.
  const applicable = requirements.filter((requirement) => requirement.outcome !== 'not_applicable');
  const criteriaMet = applicable.filter((requirement) => requirement.outcome === 'met').length;
  const criteriaNotMet = applicable.filter(
    (requirement) => requirement.outcome === 'not_met',
  ).length;
  const criteriaUnknown = applicable.filter(
    (requirement) => requirement.outcome === 'unknown',
  ).length;
  const criteriaSeen = applicable.length;
  const criteriaChecked = criteriaMet + criteriaNotMet;
  const coverage =
    criteriaSeen === 0 ? 0 : Math.round((criteriaChecked / criteriaSeen) * 100) / 100;
  const autoBlockers = explanation?.autoBlockers ?? [];
  const hardGate = explanation?.hardRejectReasons[0] ?? null;

  const counts = {
    criteriaSeen,
    criteriaChecked,
    criteriaMet,
    criteriaNotMet,
    criteriaUnknown,
    coverage,
    autoBlockers,
  };

  if (hardGate !== null) {
    return {
      ...counts,
      band: 'blocked',
      blockedBy: hardGate,
      summary:
        hardGate === 'restricted_to_internal_candidates'
          ? 'Open only to the employer’s existing staff or a named programme. Nothing in your profile can change that.'
          : `A hard gate failed: ${readable(hardGate)}. Open the advert and check before spending time on it.`,
    };
  }

  if (criteriaSeen === 0) {
    return {
      ...counts,
      band: 'criteria_unseen',
      blockedBy: null,
      summary:
        input.descriptionCompleteness === 'snippet'
          ? 'Only an excerpt of this advert was read, so no requirements were established. Add the employer’s own advert address to complete it.'
          : 'No requirements could be read for this vacancy, so nothing has been checked. Open the advert yourself.',
    };
  }

  if (criteriaChecked === 0) {
    return {
      ...counts,
      band: 'yours_to_judge',
      blockedBy: null,
      summary: `${String(criteriaSeen)} ${plural(criteriaSeen, 'requirement was', 'requirements were')} read, and none could be checked against your profile. This one is yours to judge.`,
    };
  }

  if (criteriaUnknown === 0) {
    return {
      ...counts,
      band: 'fully_checked',
      blockedBy: null,
      summary: `All ${String(criteriaSeen)} ${plural(criteriaSeen, 'requirement', 'requirements')} checked: ${String(criteriaMet)} matched your profile, ${String(criteriaNotMet)} did not.`,
    };
  }

  return {
    ...counts,
    band: 'partly_checked',
    blockedBy: null,
    summary: `${String(criteriaChecked)} of ${String(criteriaSeen)} requirements checked: ${String(criteriaMet)} matched, ${String(criteriaNotMet)} did not, ${String(criteriaUnknown)} the agent could not judge.`,
  };
}

/**
 * Groups an already-ordered list into reading order by band, keeping each band's internal order.
 *
 * Nothing is re-ranked inside a band: whatever order the caller asked for is preserved, so this adds
 * a grouping and takes no view of its own about which of two comparable vacancies is better.
 */
export function groupByShortlistBand<T>(
  entries: readonly T[],
  bandOf: (entry: T) => ShortlistBand,
): Array<{ band: ShortlistBand; label: string; entries: T[] }> {
  const groups = new Map<ShortlistBand, T[]>();
  for (const entry of entries) {
    const band = bandOf(entry);
    const existing = groups.get(band);
    if (existing === undefined) groups.set(band, [entry]);
    else existing.push(entry);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => shortlistBandOrder[left] - shortlistBandOrder[right])
    .map(([band, bandEntries]) => ({
      band,
      label: shortlistBandLabels[band],
      entries: bandEntries,
    }));
}
