/**
 * Detects an advert that is open only to an employer's existing staff, or to a named programme.
 *
 * This exists because "Business Support Officer (QA)" was shortlisted despite being restricted to
 * current JBG employees and ILM participants. The restriction had been treated as an ordinary
 * requirement sentence, and requirement sentences are matched by evidence overlap — so words like
 * "employees" and "participants" found enough generic overlap in a profile to look satisfied.
 *
 * An eligibility restriction is not that kind of requirement. Nothing in a profile can evidence
 * being an existing employee of an organisation the person does not work for. It is therefore a
 * separate deterministic gate that never consults the evidence matcher at all, and the detected
 * sentences are excluded from requirement extraction so they cannot be scored as met.
 */

export type InternalOnlyDetection = {
  /** `restricted` blocks automatically; `unclear` blocks automatic progression for review. */
  status: 'open' | 'restricted' | 'unclear';
  /** The sentences that triggered the detection, for the audit record and the tracker. */
  matchedSentences: string[];
};

/** Phrases that state the vacancy is closed to external applicants. */
const restrictedPatterns: readonly RegExp[] = [
  /\b(open|available|restricted|limited)\s+(only\s+)?to\s+(current|existing)\s+(employees|staff|colleagues)/i,
  /\bonly\s+(current|existing)\s+(employees|staff|colleagues)\b/i,
  /\binternal\s+(applicants?|candidates?|vacancy|vacancies|advert|only|appointment)\b/i,
  /\b(this\s+)?(post|position|vacancy|role|opportunity)\s+is\s+(only\s+)?(open|available)\s+to\s+(current|existing|internal)/i,
  /\bnot\s+open\s+to\s+external\s+(applicants?|candidates?)\b/i,
  /\bexternal\s+applicants?\s+(will\s+not|cannot|may\s+not)\s+be\s+considered\b/i,
  /\bredeploy(ment|ees)?\s+(candidates?|register|only)\b/i,
  /\bring[-\s]?fenced\s+to\b/i,
  /\bemployees?\s+of\s+[A-Z][\w&'’.\- ]{2,60}\s+(only|and)\b/,
  /\b(ilm|intermediate\s+labour\s+market)\s+(participants?|programme|placement)\b/i,
];

/**
 * Phrases that say the vacancy is open to people outside the organisation.
 *
 * These must address internal versus external eligibility and nothing else. Equal-opportunities
 * and diversity boilerplate — "we welcome applications from everyone", "committed to a diverse
 * workforce" — says who the employer encourages to apply, not who is eligible to apply. A real
 * MyJobScotland advert carried that boilerplate alongside "only open to current employees and ILMs
 * of JBG"; counting the boilerplate as an openness statement downgraded a genuine restriction from
 * `restricted` to `unclear`, and the vacancy stayed shortlisted at 55. Nothing that is not about
 * internal versus external eligibility belongs in this list.
 */
const openPatterns: readonly RegExp[] = [
  /\bopen\s+to\s+(both\s+)?internal\s+and\s+external\b/i,
  /\binternal\s+and\s+external\s+(applicants?|candidates?)\s+(are\s+)?welcome/i,
  /\bexternal\s+(applicants?|candidates?)\s+(are\s+)?(also\s+)?welcome/i,
];

/** Phrases that raise the question without settling it. */
const unclearPatterns: readonly RegExp[] = [
  /\binternal\s+(secondment|transfer)\b/i,
  /\bsecondment\s+opportunity\b/i,
  /\beligib(le|ility)\s+(criteria|requirements?)\s+apply\b/i,
];

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Reads advert text and any criteria document text together.
 *
 * Untrusted content: it is only ever pattern-matched here, never followed as an instruction.
 */
export function detectInternalOnlyRestriction(
  ...texts: readonly (string | null | undefined)[]
): InternalOnlyDetection {
  const all = texts.filter(
    (text): text is string => typeof text === 'string' && text.trim() !== '',
  );
  if (all.length === 0) return { status: 'open', matchedSentences: [] };

  const restricted: string[] = [];
  const unclear: string[] = [];
  let explicitlyOpen = false;

  for (const sentence of all.flatMap(sentences)) {
    if (openPatterns.some((pattern) => pattern.test(sentence))) {
      explicitlyOpen = true;
      continue;
    }
    if (restrictedPatterns.some((pattern) => pattern.test(sentence))) {
      restricted.push(sentence.slice(0, 300));
      continue;
    }
    if (unclearPatterns.some((pattern) => pattern.test(sentence)))
      unclear.push(sentence.slice(0, 300));
  }

  // An explicit "internal and external" line does not cancel an explicit restriction elsewhere:
  // when the advert says both, it is the user's to read.
  if (restricted.length > 0 && explicitlyOpen) {
    return { status: 'unclear', matchedSentences: restricted };
  }
  if (restricted.length > 0) return { status: 'restricted', matchedSentences: restricted };
  if (explicitlyOpen) return { status: 'open', matchedSentences: [] };
  if (unclear.length > 0) return { status: 'unclear', matchedSentences: unclear };
  return { status: 'open', matchedSentences: [] };
}

/** True when a sentence states an eligibility restriction, so it must not become a requirement. */
export function isEligibilityRestrictionSentence(sentence: string): boolean {
  return (
    restrictedPatterns.some((pattern) => pattern.test(sentence)) ||
    unclearPatterns.some((pattern) => pattern.test(sentence))
  );
}
