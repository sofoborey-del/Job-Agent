import type { KnowledgeFact } from '@job-agent/domain';

import type { FieldIntent } from './inventory.js';
import { realSiteHumanOnlyIntents } from './real-site.js';
import { resolveRealSiteAnswer, type RealSiteApprovedDocument } from './real-site-resolver.js';

/**
 * A reviewable set of grounded answers for one employer application, for the person to copy.
 *
 * This is the manual counterpart of prefill, and it exists because prefill is not permitted. It
 * types nothing, opens no browser and contacts no employer: it reads the profile through exactly
 * the same gates a real prefill would have to pass, and prints what those gates allow.
 *
 * Three properties are load-bearing, and `answer-pack.test.ts` pins each one:
 *
 * 1. Every value is verbatim from one verified fact, or is the filename of the approved CV. There
 *    is no composition, summarising, reformatting, date arithmetic or inference anywhere here. A
 *    detail the profile does not hold becomes "you must answer this", never a plausible guess.
 * 2. The number of employment and education rows comes from the profile, not from the form. A form
 *    with five role boxes and a profile holding two roles yields two answered rows and an explicit
 *    instruction to enter the rest by hand.
 * 3. A question on a human-only step, or carrying a human-only intent, is never given a value —
 *    even when the profile could supply one. Right to work, disclosure, equality monitoring,
 *    declarations and consent belong to the applicant.
 */

/**
 * The shape of an employer application, as an ordered list of steps a person works through.
 *
 * Deliberately not `RealSiteAdapter`. An adapter names approved domains and an execution mode,
 * because something may drive it; an outline is a description of a paper trail for a human, and
 * carries no permission of any kind. A `RealSiteAdapter` satisfies this structurally, so the
 * reviewed MyJobScotland flow can be described without inventing an adapter for a domain nobody
 * reviewed, and without a form outline ever being accepted where an adapter is required.
 */
export type ApplicationFormOutline = {
  id: string;
  version: string;
  /** Shown to the person, so they know which system this describes. */
  providerName: string;
  steps: readonly { id: string; description: string; humanOnly: boolean }[];
};

export type AnswerSourceKind = 'verified_fact' | 'approved_document' | 'reusable_answer' | 'none';

export type AnswerPackStatus = 'ready' | 'needs_you' | 'human_only';

/** One question on the employer's form, as the reviewed adapter records it. */
export type ApplicationQuestionTemplateEntry = {
  /** The adapter step this question sits on. Must match a step on the adapter. */
  stepId: string;
  /** The wording the employer's form uses, so the person can find the box. */
  label: string;
  intent: FieldIntent;
  required: boolean;
  /**
   * Set when the employer repeats this question per role or per qualification. The pack expands it
   * once for every row the profile actually records, and never beyond that.
   */
  repeatsWith?: 'employment' | 'education';
  /** Extra plain-English guidance shown under the question. */
  guidance?: string;
};

export type ApplicationQuestionTemplate = {
  formId: string;
  formVersion: string;
  entries: readonly ApplicationQuestionTemplateEntry[];
};

export type AnswerPackItem = {
  /** Stable within a pack, so the page can key a copy button on it. */
  id: string;
  stepId: string;
  label: string;
  intent: FieldIntent;
  required: boolean;
  /** "Role 2", "Qualification 1", or null for a question the form asks once. */
  rowLabel: string | null;
  status: AnswerPackStatus;
  /** Present only when `status` is `ready`. Verbatim; never derived. */
  value: string | null;
  source: {
    kind: AnswerSourceKind;
    /** What the person is told the answer came from. */
    label: string;
    evidenceFactIds: readonly string[];
  };
  /** Plain English: what to do, or why there is nothing to copy. */
  note: string;
};

export type AnswerPackSection = {
  stepId: string;
  title: string;
  humanOnly: boolean;
  items: readonly AnswerPackItem[];
};

/** A stored reusable answer the person explicitly asked to see for this application. */
export type ReusableAnswerInput = {
  topic: string;
  label: string;
  answer: string;
  sensitive: boolean;
};

export type ReusableAnswerView = ReusableAnswerInput & {
  note: string;
};

export type AnswerPackSummary = {
  total: number;
  ready: number;
  needsYou: number;
  humanOnly: number;
  /** Required questions the profile cannot answer. These are what actually hold the person up. */
  requiredNeedsYou: number;
  employmentRowsRecorded: number;
  educationRowsRecorded: number;
};

export type AnswerPack = {
  form: { id: string; version: string; providerName: string };
  /** Always false here. This pack is read and copied by a person; nothing types it. */
  prefillPerformed: false;
  sections: readonly AnswerPackSection[];
  /**
   * Reusable answers, shown only because the person named them on this request. They are listed
   * separately rather than slotted into a form question, because a stored answer to "ethnicity" is
   * not an answer to whatever wording a particular employer chose.
   */
  reusableAnswers: readonly ReusableAnswerView[];
  cvAttachment: { filename: string; sha256: string; documentId: string } | null;
  summary: AnswerPackSummary;
  /**
   * The ready answers as one block of text, for a single copy action.
   *
   * Deliberately excludes every reusable answer and every human-only question, so a copy-all can
   * never put a demographic answer or a declaration onto the clipboard.
   */
  clipboardText: string;
  warnings: readonly string[];
};

export type AnswerPackInput = {
  form: ApplicationFormOutline;
  template: ApplicationQuestionTemplate;
  facts: readonly KnowledgeFact<unknown>[];
  approvedDocument?: RealSiteApprovedDocument | null;
  /** Only the topics the person explicitly chose on this request. Defaults to none. */
  reusableAnswers?: readonly ReusableAnswerInput[];
  now?: Date;
};

/** How many rows the profile records, discovered through the same gate that would fill them. */
const maxRows = 20;

function countRows(
  kind: 'employment' | 'education',
  facts: readonly KnowledgeFact<unknown>[],
  now: Date,
): number {
  const intent: FieldIntent =
    kind === 'employment' ? 'employment.employer' : 'education.institution';
  let rows = 0;
  while (rows < maxRows) {
    const resolution = resolveRealSiteAnswer({ intent, rowIndex: rows, facts, now });
    if (resolution.status !== 'resolved') break;
    rows += 1;
  }
  return rows;
}

function rowLabelFor(
  repeatsWith: 'employment' | 'education' | undefined,
  rowIndex: number,
): string | null {
  if (repeatsWith === undefined) return null;
  const ordinal = String(rowIndex + 1);
  return repeatsWith === 'employment' ? `Role ${ordinal}` : `Qualification ${ordinal}`;
}

function humanOnlyNote(intent: FieldIntent, stepHumanOnly: boolean): string {
  if (intent === 'documents.cv') {
    return 'Attach this yourself on the employer site.';
  }
  if (intent === 'sensitive.diversity') {
    return 'Equality monitoring is optional. Answer it however you wish, or choose “Prefer not to say”.';
  }
  if (intent === 'sensitive.disability') {
    return 'This is yours to answer. The agent holds no view on it and will never fill it.';
  }
  if (intent === 'sensitive.criminal_record') {
    return 'Disclosure and PVG questions are a legal declaration. Answer them yourself.';
  }
  if (intent === 'declaration.truth' || intent === 'consent.data_processing') {
    return 'Read this in full and tick it yourself. The agent cannot declare or consent for you.';
  }
  if (intent === 'work_authorisation.status') {
    return 'Right to work is a declaration you make. Answer it from your own documents.';
  }
  return stepHumanOnly
    ? 'This whole step is yours. The agent shows nothing for it.'
    : 'This question is yours to answer.';
}

export function buildApplicationAnswerPack(input: AnswerPackInput): AnswerPack {
  const now = input.now ?? new Date();
  const { form, template, facts } = input;
  const approvedDocument = input.approvedDocument ?? null;
  const warnings: string[] = [];

  if (template.formId !== form.id || template.formVersion !== form.version) {
    // Refused rather than reconciled: a template written against another version of the form may
    // name boxes that no longer exist, and a wrong label is how an answer lands in the wrong field.
    throw new Error('question template does not match the application form');
  }

  const employmentRows = countRows('employment', facts, now);
  const educationRows = countRows('education', facts, now);

  const sections: AnswerPackSection[] = [];
  let ready = 0;
  let needsYou = 0;
  let humanOnly = 0;
  let requiredNeedsYou = 0;

  for (const step of form.steps) {
    const entries = template.entries.filter((entry) => entry.stepId === step.id);
    const items: AnswerPackItem[] = [];

    for (const entry of entries) {
      const rowCount =
        entry.repeatsWith === undefined
          ? 1
          : entry.repeatsWith === 'employment'
            ? employmentRows
            : educationRows;

      // A repeating question with no recorded rows still has to be visible: silence here would
      // read as "nothing to do" on a form that demands an employment history.
      const rowIndexes = rowCount === 0 ? [0] : [...Array(rowCount).keys()];

      for (const rowIndex of rowIndexes) {
        const rowLabel = rowLabelFor(entry.repeatsWith, rowIndex);
        const id =
          entry.repeatsWith === undefined
            ? `${entry.stepId}.${entry.intent}`
            : `${entry.stepId}.${entry.intent}.${String(rowIndex)}`;
        const base = {
          id,
          stepId: step.id,
          label: entry.label,
          intent: entry.intent,
          required: entry.required,
          rowLabel,
        };

        if (step.humanOnly || realSiteHumanOnlyIntents.has(entry.intent)) {
          humanOnly += 1;
          items.push({
            ...base,
            status: 'human_only',
            value: null,
            source: { kind: 'none', label: 'You answer this', evidenceFactIds: [] },
            note: entry.guidance ?? humanOnlyNote(entry.intent, step.humanOnly),
          });
          continue;
        }

        const resolution = resolveRealSiteAnswer({
          intent: entry.intent,
          rowIndex,
          facts,
          approvedDocument,
          now,
        });

        if (resolution.status === 'resolved') {
          ready += 1;
          const kind: AnswerSourceKind =
            resolution.source === 'approved_document' ? 'approved_document' : 'verified_fact';
          items.push({
            ...base,
            status: 'ready',
            value: resolution.value,
            source: {
              kind,
              label:
                kind === 'approved_document'
                  ? 'Your approved CV'
                  : `Verified profile fact (${String(resolution.evidenceFactIds.length)} source${resolution.evidenceFactIds.length === 1 ? '' : 's'})`,
              evidenceFactIds: resolution.evidenceFactIds,
            },
            note:
              entry.guidance ??
              'Taken word for word from your approved profile. Check it still reads correctly for this employer.',
          });
          continue;
        }

        needsYou += 1;
        if (entry.required) requiredNeedsYou += 1;
        items.push({
          ...base,
          status: 'needs_you',
          value: null,
          source: { kind: 'none', label: 'Not recorded', evidenceFactIds: [] },
          note: resolution.prompt,
        });
      }
    }

    sections.push({
      stepId: step.id,
      title: step.description,
      humanOnly: step.humanOnly,
      items,
    });
  }

  if (employmentRows === 0) {
    warnings.push(
      'No employment history is recorded in a usable form, so every role box is yours to fill. Confirm your history from your approved CV first.',
    );
  }
  if (educationRows === 0) {
    warnings.push(
      'No qualifications are recorded in a usable form, so every education box is yours to fill.',
    );
  }
  if (approvedDocument === null) {
    warnings.push('No approved CV is available to attach. Approve one on the CV review page.');
  }
  if (requiredNeedsYou > 0) {
    warnings.push(
      `${String(requiredNeedsYou)} required question(s) cannot be answered from your profile. The agent will not guess them.`,
    );
  }
  warnings.push(
    'Dates in your profile carry only the precision your CV carried. If a form demands a day, use your own records rather than picking one.',
  );

  const reusableAnswers: ReusableAnswerView[] = (input.reusableAnswers ?? []).map((entry) => ({
    ...entry,
    note: entry.sensitive
      ? 'Shown because you asked for it on this screen. It is optional, it was not sent anywhere, and you decide whether to enter it.'
      : 'Shown because you asked for it on this screen. Check it still fits this employer’s question before using it.',
  }));

  const clipboardLines: string[] = [];
  for (const section of sections) {
    const readyItems = section.items.filter((item) => item.status === 'ready');
    if (readyItems.length === 0) continue;
    clipboardLines.push(section.title);
    for (const item of readyItems) {
      const prefix = item.rowLabel === null ? item.label : `${item.rowLabel} — ${item.label}`;
      clipboardLines.push(`${prefix}: ${item.value ?? ''}`);
    }
    clipboardLines.push('');
  }

  return {
    form: { id: form.id, version: form.version, providerName: form.providerName },
    prefillPerformed: false,
    sections,
    reusableAnswers,
    cvAttachment:
      approvedDocument === null
        ? null
        : {
            filename: approvedDocument.filename,
            sha256: approvedDocument.sha256,
            documentId: approvedDocument.documentId,
          },
    summary: {
      total: ready + needsYou + humanOnly,
      ready,
      needsYou,
      humanOnly,
      requiredNeedsYou,
      employmentRowsRecorded: employmentRows,
      educationRowsRecorded: educationRows,
    },
    clipboardText: clipboardLines.join('\n').trimEnd(),
    warnings,
  };
}
