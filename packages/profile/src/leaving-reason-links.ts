/**
 * Linking a recorded reason for leaving to the role it belongs to.
 *
 * `resolveRealSiteAnswer` joins a reason to a role by comparing the employer name recorded *inside*
 * the reason with the employer on the employment row. That join is deliberately exact: a reason
 * must never be attached to an employer it does not name, because the result would be a false
 * statement on an application form.
 *
 * On real data the join fails constantly, for a dull reason. Employment rows are drafted from CV
 * lines, and a CV line often carries a town or a work pattern after the employer ("Example Ltd
 * Glasgow Hybrid"), while the reason was recorded against the bare name ("Example Ltd"). The two
 * are the same employer and the agent cannot know that.
 *
 * The fix is not a looser join. It is to let the person say, once, which reason belongs to which
 * role — and then to store the reason against the employer string the history actually uses, so the
 * exact join succeeds from then on. This module drafts that screen. It decides nothing on its own:
 * a suggestion here is a proposal for a person to accept or reject, never an applied change.
 */

export type LeavingReasonRecord = {
  /** The fact key, e.g. `employment.leaving_reasons.example_ltd`. */
  key: string;
  employer: string;
  reasonForLeaving: string;
  contractType?: string | undefined;
};

export type EmploymentRowRef = {
  rowIndex: number;
  employer: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
};

export type LeavingReasonRowDraft = {
  rowIndex: number;
  employer: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  /** Set when a reason already joins to this role exactly, so nothing needs doing. */
  linkedKey: string | null;
  /**
   * A proposal, shown for the person to accept or reject. Present only when the recorded employer
   * is a whole-word prefix of the row's employer *and* that pairing is the only one possible in
   * both directions. Anything ambiguous, partial or many-to-one is left with no suggestion.
   */
  suggestedKey: string | null;
  /** Why the suggestion was made, in plain English, so the person can check the reasoning. */
  suggestionBasis: string | null;
};

export type LeavingReasonLinkDraft = {
  rows: LeavingReasonRowDraft[];
  /** Reasons that join to no role, in the order recorded. */
  unlinkedReasons: LeavingReasonRecord[];
  warnings: string[];
};

/** The comparison `resolveRealSiteAnswer` uses. Kept identical on purpose. */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when `candidate` is a whole-word prefix of `full`, and strictly shorter. */
function isWordPrefix(candidate: string, full: string): boolean {
  return candidate !== '' && full !== candidate && full.startsWith(`${candidate} `);
}

export function draftLeavingReasonLinks(
  history: readonly EmploymentRowRef[],
  reasons: readonly LeavingReasonRecord[],
): LeavingReasonLinkDraft {
  const warnings: string[] = [];

  const exactKeyForRow = new Map<number, string>();
  const usedKeys = new Set<string>();
  for (const row of history) {
    const target = normalise(row.employer);
    const match = reasons.find((reason) => normalise(reason.employer) === target);
    if (match !== undefined) {
      exactKeyForRow.set(row.rowIndex, match.key);
      usedKeys.add(match.key);
    }
  }

  // Candidate prefix pairings, considered only between rows and reasons not already joined.
  const pairs: Array<{ rowIndex: number; key: string }> = [];
  for (const row of history) {
    if (exactKeyForRow.has(row.rowIndex)) continue;
    for (const reason of reasons) {
      if (usedKeys.has(reason.key)) continue;
      if (isWordPrefix(normalise(reason.employer), normalise(row.employer))) {
        pairs.push({ rowIndex: row.rowIndex, key: reason.key });
      }
    }
  }

  // Fails closed on ambiguity: a suggestion survives only if it is the sole option for that row and
  // the sole option for that reason. One reason that could belong to two roles suggests neither.
  const suggestionForRow = new Map<number, string>();
  for (const pair of pairs) {
    const rowOptions = pairs.filter((other) => other.rowIndex === pair.rowIndex);
    const keyOptions = pairs.filter((other) => other.key === pair.key);
    if (rowOptions.length === 1 && keyOptions.length === 1) {
      suggestionForRow.set(pair.rowIndex, pair.key);
    }
  }
  const ambiguous = pairs.filter((pair) => suggestionForRow.get(pair.rowIndex) !== pair.key).length;
  if (ambiguous > 0) {
    warnings.push(
      'Some recorded reasons could belong to more than one role, so none of those were suggested. Choose them yourself.',
    );
  }

  const rows: LeavingReasonRowDraft[] = history.map((row) => {
    const suggestedKey = suggestionForRow.get(row.rowIndex) ?? null;
    const suggestion =
      suggestedKey === null
        ? null
        : (reasons.find((reason) => reason.key === suggestedKey) ?? null);
    return {
      rowIndex: row.rowIndex,
      employer: row.employer,
      title: row.title,
      startDate: row.startDate,
      endDate: row.endDate,
      linkedKey: exactKeyForRow.get(row.rowIndex) ?? null,
      suggestedKey,
      suggestionBasis:
        suggestion === null
          ? null
          : `You recorded this reason against “${suggestion.employer}”, and this role’s employer begins with exactly that. Check it is the same employer before accepting.`,
    };
  });

  const linkedKeys = new Set([...exactKeyForRow.values()]);
  const unlinkedReasons = reasons.filter((reason) => !linkedKeys.has(reason.key));

  const unanswered = rows.filter((row) => row.linkedKey === null).length;
  if (unanswered > 0 && reasons.length > 0) {
    warnings.push(
      `${String(unanswered)} of ${String(rows.length)} role(s) have no reason for leaving the agent can use. Until they are linked, a form asking for one is yours to fill in.`,
    );
  }
  if (reasons.length === 0) {
    warnings.push('No reasons for leaving are recorded at all, so every one is yours to write.');
  }

  return { rows, unlinkedReasons, warnings };
}

export type LeavingReasonLinkRequest = { rowIndex: number; reasonKey: string };

export type ResolvedLeavingReasonLink = {
  key: string;
  /** The reason fact rewritten so the exact join succeeds. */
  value: {
    employer: string;
    reasonForLeaving: string;
    contractType?: string | undefined;
    /**
     * What the person originally typed, kept so the confirmation never destroys it. Facts are
     * versioned, so the previous value also survives in its own right.
     */
    employerAsEntered: string;
  };
};

export type LeavingReasonLinkOutcome =
  { ok: true; updates: ResolvedLeavingReasonLink[] } | { ok: false; error: string };

/**
 * Turns confirmed pairings into the fact updates that make them stick.
 *
 * It rewrites only the `employer` field, to the exact string the employment row carries, and keeps
 * the original. The reason text itself is never touched: the person is saying which employer a
 * reason belongs to, not changing what the reason says.
 */
export function applyLeavingReasonLinks(
  history: readonly EmploymentRowRef[],
  reasons: readonly LeavingReasonRecord[],
  links: readonly LeavingReasonLinkRequest[],
): LeavingReasonLinkOutcome {
  const seenRows = new Set<number>();
  const seenKeys = new Set<string>();
  const updates: ResolvedLeavingReasonLink[] = [];

  for (const link of links) {
    const row = history.find((candidate) => candidate.rowIndex === link.rowIndex);
    if (row === undefined) return { ok: false, error: 'unknown_row' };
    const reason = reasons.find((candidate) => candidate.key === link.reasonKey);
    if (reason === undefined) return { ok: false, error: 'unknown_reason' };
    // One reason belongs to one role. Both directions are checked, because either collision would
    // put the same wording against two employers or two reasons against one.
    if (seenRows.has(link.rowIndex)) return { ok: false, error: 'row_linked_twice' };
    if (seenKeys.has(link.reasonKey)) return { ok: false, error: 'reason_linked_twice' };
    seenRows.add(link.rowIndex);
    seenKeys.add(link.reasonKey);

    if (normalise(reason.employer) === normalise(row.employer)) continue; // already joins
    updates.push({
      key: reason.key,
      value: {
        employer: row.employer,
        reasonForLeaving: reason.reasonForLeaving,
        ...(reason.contractType === undefined ? {} : { contractType: reason.contractType }),
        employerAsEntered: reason.employer,
      },
    });
  }

  return { ok: true, updates };
}
