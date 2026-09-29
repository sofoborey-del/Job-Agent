/**
 * Reading an advert's own instruction to apply by email.
 *
 * The advert is untrusted data. Nothing in it is ever treated as an instruction to this agent: this
 * module decides, deterministically, whether the employer told *candidates* to apply by email, and
 * records the exact sentence that said so together with the address it named. If the advert does not
 * say so plainly, or says something else as well, nothing is produced and no application is offered.
 *
 * Three refusals matter most, and each has a test:
 *
 * 1. An advert that gives a contact address for an informal chat is not an instruction to apply by
 *    email. Enquiry wording disqualifies a sentence outright.
 * 2. An advert that also tells candidates to apply online is ambiguous. The agent must not choose a
 *    route the employer did not choose, so it refuses rather than picking the one it can automate.
 * 3. Two different addresses mean nobody knows which is right, so both are refused.
 *
 * The recipient always comes from the advert, which is the only place it can come from. That is why
 * the address is shown verbatim to the person before approval, alongside the sentence that named it
 * and whether the address belongs to the domain the advert was published on. A hostile advert can
 * put any address in front of a human reader; it cannot make this module pretend the address was
 * corroborated, and it cannot put a single word into the message that gets sent.
 */

export const emailInstructionRefusals = [
  'no_email_instruction',
  'ambiguous_application_route',
  'multiple_recipients',
  'malformed_recipient',
  'no_closing_date',
] as const;
export type EmailInstructionRefusal = (typeof emailInstructionRefusals)[number];

export type InstructionSourceField = 'advert_description' | 'criteria_document';

/** How far the recipient address could be tied back to the employer that published the advert. */
export type RecipientCorroboration = 'advert_domain' | 'employer_name' | 'none';

export type VerifiedEmailInstruction = {
  status: 'verified';
  recipient: string;
  recipientDomain: string;
  recipientCorroboration: RecipientCorroboration;
  /** The employer's sentence, verbatim. Shown to the person; never acted on as an instruction. */
  instructionText: string;
  instructionSource: InstructionSourceField;
  closingDate: {
    iso: string | null;
    /** The advert's own wording about a closing date, when it states one. */
    statedText: string | null;
    source: 'job_record' | 'advert_text';
  };
  vacancyReference: { value: string; evidence: string } | null;
  sourceUrl: string;
  jobVersion: number;
  jobContentHash: string;
};

export type RefusedEmailInstruction = {
  status: 'refused';
  reason: EmailInstructionRefusal;
  /** Plain English, for the person. Never contains an address the agent would not act on. */
  detail: string;
};

export type EmailInstructionResult = VerifiedEmailInstruction | RefusedEmailInstruction;

export type EmailInstructionInput = {
  canonicalUrl: string;
  employer: string;
  description: string;
  /** Text extracted from a criteria document the advert links, when one was read. */
  personSpecificationText?: string | null;
  /** The closing date the discovery record holds, which is authoritative when present. */
  closesAt: string | null;
  jobVersion: number;
  jobContentHash: string;
};

/**
 * Wording that instructs a candidate to apply by email. Each entry must express *applying*, not
 * merely contacting: "email us for details" is not an application route.
 */
const applicationInstructionPatterns: readonly RegExp[] = [
  /\bapply\s+(?:by|via|through|using)\s+e-?mail\b/i,
  /\bapplications?\s+(?:should\s+be\s+|must\s+be\s+|are\s+to\s+be\s+|can\s+be\s+)?(?:made|sent|submitted|returned|emailed)\s+(?:by|via|to|through)\b/i,
  /\be-?mail\s+your\s+(?:completed\s+)?(?:application|cv|curriculum\s+vitae|form)\b/i,
  /\b(?:send|submit|return|forward)\s+(?:your|the|a|an|completed)\s+(?:completed\s+)?(?:application|cv|curriculum\s+vitae|form|application\s+form)\b/i,
  /\bto\s+apply[^.]{0,40}\be-?mail\b/i,
  /\bapply\s+in\s+writing\s+to\b/i,
  /\bcompleted\s+application\s+forms?\s+(?:should|must|can)\b/i,
];

/**
 * Wording that makes a sentence an enquiry rather than an application route. Checked first, so an
 * address offered "for an informal discussion" can never become an application recipient.
 */
const enquiryPatterns: readonly RegExp[] = [
  /\binformal\s+(?:chat|discussion|enquir|conversation|visit|contact)/i,
  /\bfor\s+(?:further|more|additional)\s+(?:information|details|enquiries)/i,
  /\bif\s+you\s+(?:have|would\s+like)\s+(?:any\s+)?(?:questions|queries|further)/i,
  /\bto\s+(?:discuss|arrange)\b/i,
  /\bqueries\s+(?:about|regarding|to)\b/i,
  /\bfind\s+out\s+more\b/i,
  /\b(?:technical|website|recruitment\s+system)\s+(?:support|issues|problems)\b/i,
];

/** Wording that says the employer wants an online application. Its presence makes the route unclear. */
const onlineApplicationPatterns: readonly RegExp[] = [
  /\bapply\s+online\b/i,
  /\bapply\s+(?:via|through|on|using)\s+(?:our|the)\s+(?:website|portal|site|recruitment\s+system)\b/i,
  /\bcomplete\s+(?:the|an|your)\s+online\s+application\b/i,
  /\bonline\s+application\s+form\b/i,
  /\bclick\s+(?:the\s+)?apply\b/i,
  /\bapply\s+now\s+button\b/i,
  /\bapplications?\s+(?:are\s+)?only\s+accepted\s+online\b/i,
  /\bregister\s+(?:an\s+)?account\s+to\s+apply\b/i,
];

const closingDatePattern = /\b(?:closing|close[sd]?|deadline|last)\s*(?:date|day)?\b[^.\n]{0,80}/i;

// A label, a required separator, then a value. The separator is mandatory and the value must carry
// a digit (checked below), because "Ref" followed by an ordinary word is not a vacancy reference.
const vacancyReferencePattern =
  /\b(?:(?:vacancy|job|post)\s+)?(?:reference|ref)\b\s*(?:number|no\.?|#)?\s*[:\-–]\s*([A-Za-z0-9][A-Za-z0-9/\-_]{2,19})\b/i;

// Deliberately conservative. An address this does not accept is refused rather than repaired.
const emailAddressPattern = /\b([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24})\b/g;

/** Splits advert text into the units a sentence-level rule can be applied to. */
export function advertSegments(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+(?=[A-Z0-9])/))
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter((segment) => segment !== '');
}

function matchesAny(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function addressesIn(segment: string): string[] {
  const found: string[] = [];
  for (const match of segment.matchAll(emailAddressPattern)) {
    const local = match[1];
    const domain = match[2];
    if (local === undefined || domain === undefined) continue;
    found.push(`${local}@${domain.toLowerCase()}`);
  }
  return [...new Set(found)];
}

/** Everything after the first label, lowercased. `www.x.gov.uk` and `x.gov.uk` compare equal. */
function comparableHost(host: string): string {
  const lower = host.toLowerCase().replace(/\.$/, '');
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

function hostRelated(left: string, right: string): boolean {
  const a = comparableHost(left);
  const b = comparableHost(right);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Words in an employer name worth matching a domain against. */
function employerTokens(employer: string): string[] {
  const generic = new Set([
    'council',
    'city',
    'the',
    'of',
    'and',
    'nhs',
    'trust',
    'board',
    'limited',
    'ltd',
    'plc',
    'group',
    'services',
    'service',
    'authority',
    'partnership',
    'health',
    'social',
    'care',
    'school',
    'academy',
    'university',
    'college',
  ]);
  return employer
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !generic.has(token));
}

function corroborate(
  recipientDomain: string,
  canonicalUrl: string,
  employer: string,
): RecipientCorroboration {
  let advertHost: string | null = null;
  try {
    advertHost = new URL(canonicalUrl).hostname;
  } catch {
    advertHost = null;
  }
  if (advertHost !== null && hostRelated(recipientDomain, advertHost)) return 'advert_domain';
  const domainWords = comparableHost(recipientDomain).split(/[^a-z0-9]+/);
  const tokens = employerTokens(employer);
  if (tokens.some((token) => domainWords.includes(token))) return 'employer_name';
  return 'none';
}

function validRecipient(address: string): boolean {
  if (address.length > 254) return false;
  const [local, domain] = address.split('@');
  if (local === undefined || domain === undefined) return false;
  if (local === '' || local.length > 64) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (domain.startsWith('-') || domain.includes('..') || !domain.includes('.')) return false;
  return true;
}

type Candidate = {
  segment: string;
  source: InstructionSourceField;
  addresses: string[];
};

function collectCandidates(text: string, source: InstructionSourceField): Candidate[] {
  const candidates: Candidate[] = [];
  for (const segment of advertSegments(text)) {
    const addresses = addressesIn(segment);
    if (addresses.length === 0) continue;
    if (matchesAny(enquiryPatterns, segment)) continue;
    if (!matchesAny(applicationInstructionPatterns, segment)) continue;
    candidates.push({ segment, source, addresses });
  }
  return candidates;
}

function refuse(reason: EmailInstructionRefusal, detail: string): RefusedEmailInstruction {
  return { status: 'refused', reason, detail };
}

/**
 * Decides whether this advert tells candidates to apply by email, and to whom.
 *
 * Returns a refusal whenever the answer is anything other than one plain instruction naming one
 * address. There is no partial success: an application is either fully evidenced or not offered.
 */
export function detectEmailApplicationInstruction(
  input: EmailInstructionInput,
): EmailInstructionResult {
  const specification = input.personSpecificationText ?? '';
  const candidates = [
    ...collectCandidates(input.description, 'advert_description'),
    ...collectCandidates(specification, 'criteria_document'),
  ];

  if (candidates.length === 0) {
    return refuse(
      'no_email_instruction',
      'This advert does not instruct candidates to apply by email, so there is nothing to send.',
    );
  }

  const recipients = [...new Set(candidates.flatMap((candidate) => candidate.addresses))];
  if (recipients.length > 1) {
    return refuse(
      'multiple_recipients',
      `The advert names ${String(recipients.length)} different addresses in its application instructions, so the agent cannot tell which one is meant.`,
    );
  }

  const recipient = recipients[0];
  const chosen = candidates[0];
  if (recipient === undefined || chosen === undefined) {
    return refuse('no_email_instruction', 'No application address could be read from the advert.');
  }
  if (!validRecipient(recipient)) {
    return refuse(
      'malformed_recipient',
      'The address in the application instruction is not a well-formed email address.',
    );
  }

  // An advert that also points at an online form has not chosen email. Choosing for the employer is
  // exactly the kind of guess this project does not make.
  const wholeAdvert = `${input.description}\n${specification}`;
  const online = advertSegments(wholeAdvert).find((segment) =>
    matchesAny(onlineApplicationPatterns, segment),
  );
  if (online !== undefined) {
    return refuse(
      'ambiguous_application_route',
      'The advert asks for an online application as well as naming an email address, so the route is unclear. Apply the way the employer asks.',
    );
  }

  const statedClosing = closingDatePattern.exec(wholeAdvert)?.[0]?.trim() ?? null;
  if (input.closesAt === null && statedClosing === null) {
    return refuse(
      'no_closing_date',
      'No closing date is recorded for this vacancy and the advert does not state one, so the agent cannot confirm it is still open.',
    );
  }

  const referenceMatch = vacancyReferencePattern.exec(wholeAdvert);
  const candidateReference = referenceMatch?.[1] ?? null;
  const referenceValue =
    candidateReference !== null && /[0-9]/.test(candidateReference) ? candidateReference : null;
  const domain = recipient.split('@')[1] ?? '';

  return {
    status: 'verified',
    recipient,
    recipientDomain: domain,
    recipientCorroboration: corroborate(domain, input.canonicalUrl, input.employer),
    instructionText: chosen.segment,
    instructionSource: chosen.source,
    closingDate: {
      iso: input.closesAt,
      statedText: statedClosing,
      source: input.closesAt === null ? 'advert_text' : 'job_record',
    },
    vacancyReference:
      referenceValue === null || referenceMatch === null
        ? null
        : { value: referenceValue, evidence: referenceMatch[0].trim() },
    sourceUrl: input.canonicalUrl,
    jobVersion: input.jobVersion,
    jobContentHash: input.jobContentHash,
  };
}
