import { describe, expect, it } from 'vitest';

import {
  applyLeavingReasonLinks,
  draftLeavingReasonLinks,
  type EmploymentRowRef,
  type LeavingReasonRecord,
} from './leaving-reason-links.js';

/**
 * Every employer here is invented. The shapes mirror what a real profile hits: employment rows
 * drafted from CV lines that carry a town or work pattern after the employer, and reasons recorded
 * against the bare name.
 */

function row(rowIndex: number, employer: string): EmploymentRowRef {
  return { rowIndex, employer, title: 'Adviser', startDate: 'March 2021', endDate: 'August 2022' };
}

function reason(key: string, employer: string): LeavingReasonRecord {
  return {
    key: `employment.leaving_reasons.${key}`,
    employer,
    reasonForLeaving: `Left ${employer} for an invented reason`,
  };
}

describe('drafting reason-for-leaving links', () => {
  it('reports a role that already joins exactly, and proposes nothing for it', () => {
    const draft = draftLeavingReasonLinks(
      [row(0, 'Invented Trading Ltd')],
      [reason('invented', 'Invented Trading Ltd')],
    );
    expect(draft.rows[0]?.linkedKey).toBe('employment.leaving_reasons.invented');
    expect(draft.rows[0]?.suggestedKey).toBeNull();
    expect(draft.unlinkedReasons).toHaveLength(0);
  });

  it('matches case and punctuation the way the resolver does', () => {
    const draft = draftLeavingReasonLinks(
      [row(0, 'Smith & Jones Ltd.')],
      [reason('sj', 'smith and jones ltd')],
    );
    expect(draft.rows[0]?.linkedKey).not.toBeNull();
  });

  it('proposes the whole-word prefix case that real CV rows produce', () => {
    // "Invented Trading Ltd Glasgow Hybrid" is the CV line; the reason was recorded bare.
    const draft = draftLeavingReasonLinks(
      [row(0, 'Invented Trading Ltd Glasgow Hybrid')],
      [reason('invented', 'Invented Trading Ltd')],
    );
    expect(draft.rows[0]?.linkedKey).toBeNull();
    expect(draft.rows[0]?.suggestedKey).toBe('employment.leaving_reasons.invented');
    expect(draft.rows[0]?.suggestionBasis).toContain('Invented Trading Ltd');
  });

  it('never proposes a partial word as a prefix', () => {
    const draft = draftLeavingReasonLinks(
      [row(0, 'Inventedly Different Ltd')],
      [reason('invented', 'Invented')],
    );
    expect(draft.rows[0]?.suggestedKey).toBeNull();
  });

  it('proposes nothing when one reason could belong to two roles', () => {
    const draft = draftLeavingReasonLinks(
      [row(0, 'Invented Group North'), row(1, 'Invented Group South')],
      [reason('invented', 'Invented Group')],
    );
    expect(draft.rows.every((entry) => entry.suggestedKey === null)).toBe(true);
    expect(draft.warnings.some((warning) => warning.includes('more than one role'))).toBe(true);
  });

  it('proposes nothing when one role could take two reasons', () => {
    const draft = draftLeavingReasonLinks(
      [row(0, 'Invented Group Trading Ltd')],
      [reason('a', 'Invented'), reason('b', 'Invented Group')],
    );
    expect(draft.rows[0]?.suggestedKey).toBeNull();
  });

  it('proposes nothing on a mere shared word', () => {
    const draft = draftLeavingReasonLinks(
      [row(0, 'Northern Invented Services')],
      [reason('other', 'Southern Invented Holdings')],
    );
    expect(draft.rows[0]?.suggestedKey).toBeNull();
    expect(draft.unlinkedReasons).toHaveLength(1);
  });

  it('reproduces the real profile’s shape: some exact, some proposed, some neither', () => {
    const draft = draftLeavingReasonLinks(
      [
        row(0, 'First Invented Ltd Glasgow Remote'),
        row(1, 'Second Invented Plc Hybrid'),
        row(2, 'Third Invented Ltd'),
        row(3, 'Fourth Invented'),
      ],
      [reason('first', 'First Invented Ltd'), reason('second', 'Second Invented Plc')],
    );
    expect(draft.rows.map((entry) => entry.suggestedKey)).toEqual([
      'employment.leaving_reasons.first',
      'employment.leaving_reasons.second',
      null,
      null,
    ]);
    expect(draft.warnings.some((warning) => warning.includes('4 role(s)'))).toBe(true);
  });

  it('says plainly when nothing is recorded at all', () => {
    const draft = draftLeavingReasonLinks([row(0, 'Invented Ltd')], []);
    expect(draft.warnings.some((warning) => warning.includes('No reasons for leaving'))).toBe(true);
  });
});

describe('applying confirmed links', () => {
  const history = [row(0, 'First Invented Ltd Glasgow Remote'), row(1, 'Second Invented Plc')];
  const reasons = [reason('first', 'First Invented Ltd'), reason('second', 'Second Invented Plc')];

  it('rewrites only the employer, keeps the wording, and keeps what was typed', () => {
    const outcome = applyLeavingReasonLinks(history, reasons, [
      { rowIndex: 0, reasonKey: 'employment.leaving_reasons.first' },
    ]);
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.updates).toHaveLength(1);
    expect(outcome.updates[0]?.value).toMatchObject({
      employer: 'First Invented Ltd Glasgow Remote',
      reasonForLeaving: 'Left First Invented Ltd for an invented reason',
      employerAsEntered: 'First Invented Ltd',
    });
  });

  it('writes nothing for a pairing that already joins', () => {
    const outcome = applyLeavingReasonLinks(history, reasons, [
      { rowIndex: 1, reasonKey: 'employment.leaving_reasons.second' },
    ]);
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.updates).toHaveLength(0);
  });

  it('refuses one reason against two roles, and two reasons against one role', () => {
    expect(
      applyLeavingReasonLinks(history, reasons, [
        { rowIndex: 0, reasonKey: 'employment.leaving_reasons.first' },
        { rowIndex: 1, reasonKey: 'employment.leaving_reasons.first' },
      ]),
    ).toEqual({ ok: false, error: 'reason_linked_twice' });
    expect(
      applyLeavingReasonLinks(history, reasons, [
        { rowIndex: 0, reasonKey: 'employment.leaving_reasons.first' },
        { rowIndex: 0, reasonKey: 'employment.leaving_reasons.second' },
      ]),
    ).toEqual({ ok: false, error: 'row_linked_twice' });
  });

  it('refuses a role or a reason it does not hold', () => {
    expect(
      applyLeavingReasonLinks(history, reasons, [
        { rowIndex: 9, reasonKey: 'employment.leaving_reasons.first' },
      ]),
    ).toEqual({ ok: false, error: 'unknown_row' });
    expect(
      applyLeavingReasonLinks(history, reasons, [
        { rowIndex: 0, reasonKey: 'employment.leaving_reasons.invented' },
      ]),
    ).toEqual({ ok: false, error: 'unknown_reason' });
  });

  it('allows a link the draft would not have proposed, because the person decides', () => {
    // No prefix relationship at all: the person is asserting these are the same employer.
    const outcome = applyLeavingReasonLinks(
      [row(0, 'Renamed Invented Ltd')],
      [reason('old', 'Former Invented Name')],
      [{ rowIndex: 0, reasonKey: 'employment.leaving_reasons.old' }],
    );
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.updates[0]?.value.employer).toBe('Renamed Invented Ltd');
  });
});
