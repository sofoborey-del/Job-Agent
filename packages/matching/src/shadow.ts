import { defaultAgentConfig, type AgentConfig } from '@job-agent/config';
import type {
  AnnualSalary,
  KnowledgeFact,
  MatchDecision,
  RequirementMatch,
} from '@job-agent/domain';

import { decideMatch, evaluateSalary } from './index.js';
import {
  detectInternalOnlyRestriction,
  isEligibilityRestrictionSentence,
  type InternalOnlyDetection,
} from './internal-only.js';

const stopWords = new Set([
  'about',
  'after',
  'also',
  'and',
  'applicant',
  'applicants',
  'are',
  'essential',
  'for',
  'from',
  'have',
  'into',
  'must',
  'need',
  'our',
  'required',
  'requirement',
  'requirements',
  'that',
  'the',
  'their',
  'this',
  'with',
  'will',
  'you',
  'your',
]);

/** Bumped whenever extraction, scoring or gating behaviour changes. Part of the match idempotency key. */
/**
 * Bump this whenever matching behaviour changes.
 *
 * It is part of the match-run idempotency key, so a decision already recorded for an unchanged
 * job, profile and configuration is reused rather than recalculated. That is what makes results
 * reproducible — and it also means a change to the matcher does not reach already-scored jobs
 * until this string moves. A safety fix that is not accompanied by a bump here silently does not
 * apply to anything already in the tracker.
 *
 * 1.4.0: equal-opportunities boilerplate no longer downgrades an explicit internal-only
 * restriction, which had left ineligible vacancies shortlisted.
 */
export const MATCHER_VERSION = 'shadow-1.4.0';

export type ShadowJob = {
  id: string;
  title: string;
  employer: string;
  location: string;
  description: string;
  salary: {
    minimumMinor?: number;
    maximumMinor?: number;
    currency: 'GBP';
    basis: 'annual_base' | 'hourly' | 'unknown';
    confidence: number;
    sourceText: string;
  } | null;
  contractType: string | null;
  employmentTypes: string[];
  workPattern: string | null;
  closesAt: string | null;
  /**
   * Criteria read from a document the advert links, when there was one. Untrusted advert content:
   * it is fed to the same deterministic extractor as the page text and nothing else.
   */
  personSpecification?: {
    status: 'absent' | 'read' | 'unreadable';
    text?: string;
    reason?: string;
  };
  /**
   * Whether `description` is the whole advert or only an excerpt. Aggregator APIs return a
   * snippet, and a snippet is not a person specification: no criteria can be established from one,
   * however many requirement-shaped sentences it happens to contain.
   */
  descriptionCompleteness?: 'full' | 'snippet';
};

export type ExtractedRequirement = {
  id: string;
  text: string;
  mandatory: true;
  /** Where the requirement sentence came from. */
  source: 'advert_text' | 'person_specification';
  outcome: RequirementMatch['outcome'];
  evidenceFactIds: string[];
  confidence: number;
  explanation: string;
};

export type ShadowMatchResult = {
  decision: MatchDecision;
  salaryGate: 'pass' | 'reject' | 'unknown';
  requirements: ExtractedRequirement[];
  /** Where each mandatory requirement was found, and whether any criteria were visible at all. */
  criteria: {
    personSpecification: 'absent' | 'read' | 'unreadable';
    fromAdvertText: number;
    fromPersonSpecification: number;
    visible: boolean;
    unreadableReason?: string;
    /** 'snippet' means the advert text was an excerpt, so no criteria were established. */
    descriptionCompleteness: 'full' | 'snippet';
  };
  /** Whether the advert is open to external applicants, and the sentences that decided it. */
  eligibility: InternalOnlyDetection;
  signals: {
    titleFit: number;
    skillsFit: number;
    experienceFit: number;
    locationFit: number;
    contractFit: number;
  };
  mode: 'shadow_only';
};

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase('en-GB')
      .replace(/[^a-z0-9+#]+/g, ' ')
      .split(/\s+/)
      .map((item) => {
        if (item === 'advisor' || item === 'advisors') return 'adviser';
        if (item === 'services') return 'service';
        if (item.endsWith('ies') && item.length > 4) return `${item.slice(0, -3)}y`;
        if (item.endsWith('s') && !item.endsWith('ss') && item.length > 4) return item.slice(0, -1);
        return item;
      })
      .filter((item) => item.length >= 3 && !stopWords.has(item)),
  );
}

function serialise(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(serialise).join(' ');
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>)
      .map(serialise)
      .join(' ');
  }
  return '';
}

function overlap(left: Set<string>, right: Set<string>, denominator: 'left' | 'smaller'): number {
  if (left.size === 0 || right.size === 0) return 0;
  let matches = 0;
  for (const token of left) if (right.has(token)) matches += 1;
  const size = denominator === 'left' ? left.size : Math.min(left.size, right.size);
  return Math.min(1, matches / Math.max(1, size));
}

function factsWithPrefix(
  facts: readonly KnowledgeFact<unknown>[],
  prefix: string,
): KnowledgeFact<unknown>[] {
  return facts.filter(
    (fact) =>
      fact.status === 'verified' &&
      fact.allowedPurposes.includes('matching') &&
      fact.key.startsWith(prefix),
  );
}

function factTokens(facts: readonly KnowledgeFact<unknown>[], prefix: string): Set<string> {
  return tokens(
    factsWithPrefix(facts, prefix)
      .map((fact) => serialise(fact.value))
      .join(' '),
  );
}

function firstFactValue(facts: readonly KnowledgeFact<unknown>[], key: string): unknown {
  return facts.find(
    (fact) =>
      fact.key === key && fact.status === 'verified' && fact.allowedPurposes.includes('matching'),
  )?.value;
}

/** The deterministic requirement extractor. Exported so ingestion and matching agree exactly. */
export function extractMandatoryRequirements(description: string): string[] {
  const candidates = description
    .split(/\n|(?<=[.!?])\s+/)
    .map((line) => line.trim().replace(/^[•*\-–—]+\s*/, ''))
    .filter((line) => line.length >= 12 && line.length <= 500)
    // Only treat wording that asserts a candidate prerequisite as mandatory. Broadly matching the
    // words "essential" or "required" also captures boilerplate such as "essential city
    // services" and "within required timescales", which unfairly depresses otherwise good roles.
    .filter((line) =>
      /\b(?:you|applicants?|candidates?)\s+(?:will\s+)?must\b|\bmust\s+(?:have|hold|be|demonstrate|possess|provide|obtain)|\b(?:is|are)\s+(?:an?\s+)?essential\b|\b(?:is|are)\s+required\b|\b(?:qualification|experience|knowledge|skill|licen[cs]e|membership|registration|clearance)\s+(?:is\s+)?(?:essential|required)\b|\bneed(?:s)?\s+to\s+(?:have|hold|be|demonstrate|possess|provide|obtain)\b/i.test(
        line,
      ),
    )
    .filter(
      (line) =>
        !/\b(?:no qualifications? required|disability confident|second-class mail|required (?:timescales?|standards?|training)|key competency requirement|essential and generally preferred)\b/i.test(
          line,
        ),
    );
  return [...new Set(candidates)].slice(0, 25);
}

function annualSalary(job: ShadowJob): AnnualSalary | undefined {
  if (job.salary?.basis !== 'annual_base') return undefined;
  return {
    basis: 'annual_base',
    ...(job.salary.minimumMinor === undefined
      ? {}
      : { minimum: { amountMinor: job.salary.minimumMinor, currency: 'GBP' } }),
    ...(job.salary.maximumMinor === undefined
      ? {}
      : { maximum: { amountMinor: job.salary.maximumMinor, currency: 'GBP' } }),
    confidence: job.salary.confidence,
    sourceText: job.salary.sourceText,
  };
}

function listValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function shadowMatch(
  job: ShadowJob,
  facts: readonly KnowledgeFact<unknown>[],
  config: AgentConfig = defaultAgentConfig,
  now = new Date(),
): ShadowMatchResult {
  const usableFacts = facts.filter(
    (fact) => fact.status === 'verified' && fact.allowedPurposes.includes('matching'),
  );
  const allEvidence = usableFacts.map((fact) => ({ fact, words: tokens(serialise(fact.value)) }));

  const truncated = job.descriptionCompleteness === 'snippet';
  const specification = job.personSpecification;
  const specificationStatus = specification?.status ?? 'absent';
  const advertSentences = extractMandatoryRequirements(job.description);
  const specificationSentences =
    specificationStatus === 'read' && specification?.text !== undefined
      ? extractMandatoryRequirements(specification.text).filter(
          (sentence) => !advertSentences.includes(sentence),
        )
      : [];
  // An eligibility restriction is not a requirement evidence can meet, so it never becomes one.
  const internalOnly = detectInternalOnlyRestriction(job.description, specification?.text);
  const candidateSentences: Array<{ text: string; source: ExtractedRequirement['source'] }> = [
    ...advertSentences.map((text) => ({ text, source: 'advert_text' as const })),
    ...specificationSentences.map((text) => ({ text, source: 'person_specification' as const })),
  ].filter(({ text }) => !isEligibilityRestrictionSentence(text));

  const requirements: ExtractedRequirement[] = candidateSentences.map(
    ({ text: requirementText, source }, index) => {
      const requirementTokens = tokens(requirementText);
      const ranked = allEvidence
        .map(({ fact, words }) => ({ fact, score: overlap(requirementTokens, words, 'left') }))
        .filter(({ score }) => score >= 0.35)
        .sort((left, right) => right.score - left.score)
        .slice(0, 3);
      const best = ranked[0]?.score ?? 0;
      const met = best >= 0.55;
      return {
        id: `mandatory-${String(index + 1)}`,
        text: requirementText,
        mandatory: true,
        source,
        outcome: met ? 'met' : 'unknown',
        evidenceFactIds: met ? ranked.map(({ fact }) => fact.id) : [],
        confidence: met ? Math.min(0.95, best) : 0.5,
        explanation: met
          ? 'Verified profile evidence has strong deterministic keyword coverage.'
          : 'No sufficiently strong verified evidence was found; user review is required.',
      };
    },
  );

  const titleTokens = tokens(job.title);
  const targetRoleTokens = factTokens(facts, 'preferences.target_roles');
  const skillTokens = factTokens(facts, 'skills.');
  const employmentTokens = factTokens(facts, 'employment.');
  const jobTokens = tokens(`${job.title} ${job.description}`);
  const titleFit = Math.max(overlap(titleTokens, targetRoleTokens, 'smaller'), 0.2);
  const skillsFit = Math.min(1, overlap(skillTokens, jobTokens, 'smaller') * 1.2);
  const experienceFit = Math.min(1, overlap(employmentTokens, jobTokens, 'smaller') * 1.25);

  const acceptedLocations = listValue(firstFactValue(facts, 'preferences.location'));
  const locationMaterial = `${job.location} ${job.workPattern ?? ''}`.toLocaleLowerCase('en-GB');
  const locationFit = acceptedLocations.some((location) => {
    const normalised = location.toLocaleLowerCase('en-GB');
    return locationMaterial.includes(normalised) || normalised.includes(locationMaterial);
  })
    ? 1
    : acceptedLocations.some(
          (location) => /remote|hybrid/i.test(location) && /remote|hybrid/i.test(locationMaterial),
        )
      ? 0.9
      : 0.5;

  const acceptedContracts = listValue(firstFactValue(facts, 'preferences.contract_type'));
  const normalisedContract = (job.contractType ?? '')
    .toLocaleLowerCase('en-GB')
    .replace(/\s+/g, '_');
  const contractFit =
    normalisedContract === '' || acceptedContracts.length === 0
      ? 0.5
      : acceptedContracts.some((contract) => normalisedContract.includes(contract))
        ? 1
        : 0.35;

  const exclusions = listValue(firstFactValue(facts, 'preferences.exclusions')).map((item) =>
    item.toLocaleLowerCase('en-GB'),
  );
  const jobMaterial = `${job.title} ${job.employer} ${job.description}`.toLocaleLowerCase('en-GB');
  const excluded = exclusions.some((item) => item !== '' && jobMaterial.includes(item));
  const workAuthorisation = firstFactValue(facts, 'work_authorisation.gb');
  const authorised =
    typeof workAuthorisation === 'object' && workAuthorisation !== null
      ? (workAuthorisation as Record<string, unknown>).authorised
      : 'unknown';
  const salaryValue = annualSalary(job);
  const salaryGate = evaluateSalary(salaryValue, config.matching.minimumSalary.amountMinor);
  const requirementMatches: RequirementMatch[] = requirements.map((requirement) => ({
    requirementId: requirement.id,
    outcome: requirement.outcome,
    evidenceFactIds: requirement.evidenceFactIds,
    confidence: requirement.confidence,
    explanation: requirement.explanation,
  }));
  const metRequirements = requirements.filter(
    (requirement) => requirement.outcome === 'met',
  ).length;
  const evidenceCoverage = requirements.length === 0 ? 0.6 : metRequirements / requirements.length;
  const jobOpen = job.closesAt === null || new Date(job.closesAt).getTime() > now.getTime();

  const decision = decideMatch(
    {
      ...(salaryValue === undefined ? {} : { salary: salaryValue }),
      requirements: requirementMatches,
      mandatoryRequirementIds: requirements.map((requirement) => requirement.id),
      dimensions: {
        mandatoryCoverage: evidenceCoverage,
        relevantSkills: skillsFit,
        relevantExperience: experienceFit,
        locationFit,
        compensationQuality: salaryGate === 'pass' ? 1 : salaryGate === 'unknown' ? 0.4 : 0,
        otherPreferences: (titleFit + contractFit) / 2,
      },
      preferredCriteriaNotMet: contractFit < 0.5 ? 1 : 0,
      weakEvidenceCount: requirements.length - metRequirements,
      evidenceCoverage,
      decisionConfidence: salaryValue === undefined ? 0.7 : 0.85,
      locationCompatible: true,
      contractCompatible: true,
      workAuthorisationCompatible:
        typeof authorised === 'boolean' ? authorised : ('unknown' as const),
      excluded,
      duplicateApplication: false,
      jobOpen,
      sitePolicy: 'prefill_only',
      dailyAutoSlotAvailable: false,
      answersComplete: false,
      humanOnlyStepPresent: true,
      personSpecification: specificationStatus,
      // A snippet can never establish criteria, whatever it happens to contain.
      mandatoryCriteriaVisible: truncated ? false : requirements.length > 0,
      internalOnly: internalOnly.status,
      descriptionCompleteness: job.descriptionCompleteness ?? 'full',
    },
    config,
  );

  return {
    decision,
    salaryGate,
    requirements,
    criteria: {
      personSpecification: specificationStatus,
      fromAdvertText: advertSentences.length,
      fromPersonSpecification: specificationSentences.length,
      visible: truncated ? false : requirements.length > 0,
      descriptionCompleteness: job.descriptionCompleteness ?? 'full',
      ...(specification?.reason === undefined ? {} : { unreadableReason: specification.reason }),
    },
    eligibility: internalOnly,
    signals: { titleFit, skillsFit, experienceFit, locationFit, contractFit },
    mode: 'shadow_only',
  };
}
