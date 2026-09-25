import type { AgentConfig } from '@job-agent/config';
import type {
  AnnualSalary,
  MatchDecision,
  MatchDimensions,
  RequirementMatch,
  SitePolicyDecision,
} from '@job-agent/domain';

export type SalaryGate = 'pass' | 'reject' | 'unknown';

export type DecisionInput = {
  salary?: AnnualSalary;
  requirements: RequirementMatch[];
  mandatoryRequirementIds: string[];
  dimensions: MatchDimensions;
  preferredCriteriaNotMet: number;
  weakEvidenceCount: number;
  evidenceCoverage: number;
  decisionConfidence: number;
  locationCompatible: boolean;
  contractCompatible: boolean;
  workAuthorisationCompatible: boolean | 'unknown';
  excluded: boolean;
  duplicateApplication: boolean;
  jobOpen: boolean;
  sitePolicy: SitePolicyDecision;
  dailyAutoSlotAvailable: boolean;
  answersComplete: boolean;
  humanOnlyStepPresent: boolean;
  /**
   * Whether the advert's linked criteria document could be read. `unreadable` means criteria exist
   * that nobody has seen, which must block automatic progression rather than read as "no
   * requirements". Omitted is treated as `absent`, which is the pre-attachment behaviour.
   */
  personSpecification?: 'absent' | 'read' | 'unreadable';
  /**
   * False when no mandatory criteria could be established at all. An advert whose requirements sit
   * in a document the agent never read must not look like an advert with nothing to satisfy.
   */
  mandatoryCriteriaVisible?: boolean;
};

const weights: Readonly<Record<keyof MatchDimensions, number>> = {
  mandatoryCoverage: 40,
  relevantSkills: 20,
  relevantExperience: 15,
  locationFit: 10,
  compensationQuality: 10,
  otherPreferences: 5,
};

function assertUnitInterval(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}

export function evaluateSalary(
  salary: AnnualSalary | undefined,
  salaryFloorMinor: number,
): SalaryGate {
  if (salary === undefined || salary.confidence < 0.9) return 'unknown';
  if (salary.minimum?.currency !== 'GBP' && salary.minimum !== undefined) return 'unknown';
  if (salary.maximum?.currency !== 'GBP' && salary.maximum !== undefined) return 'unknown';

  const minimum = salary.minimum?.amountMinor;
  const maximum = salary.maximum?.amountMinor;

  if (minimum !== undefined && minimum >= salaryFloorMinor) return 'pass';
  if (maximum !== undefined && maximum < salaryFloorMinor) return 'reject';
  return 'unknown';
}

export function calculateScore(
  dimensions: MatchDimensions,
  preferredCriteriaNotMet: number,
  weakEvidenceCount: number,
): number {
  let score = 0;
  for (const [dimension, weight] of Object.entries(weights) as Array<
    [keyof MatchDimensions, number]
  >) {
    const value = dimensions[dimension];
    assertUnitInterval(dimension, value);
    score += value * weight;
  }

  const preferredPenalty = Math.min(Math.max(preferredCriteriaNotMet, 0) * 10, 20);
  const weakEvidencePenalty = Math.min(Math.max(weakEvidenceCount, 0) * 5, 15);
  return Math.max(0, Math.round(score - preferredPenalty - weakEvidencePenalty));
}

export function decideMatch(input: DecisionInput, config: AgentConfig): MatchDecision {
  assertUnitInterval('evidenceCoverage', input.evidenceCoverage);
  assertUnitInterval('decisionConfidence', input.decisionConfidence);

  const score = calculateScore(
    input.dimensions,
    input.preferredCriteriaNotMet,
    input.weakEvidenceCount,
  );
  const salaryGate = evaluateSalary(input.salary, config.matching.minimumSalary.amountMinor);
  const hardRejectReasons: string[] = [];
  const autoBlockers: string[] = [];
  const explanation: string[] = [];

  if (!input.jobOpen) hardRejectReasons.push('job_not_open');
  if (input.duplicateApplication) hardRejectReasons.push('duplicate_application');
  if (input.excluded) hardRejectReasons.push('user_exclusion_rule');
  if (!input.locationCompatible) hardRejectReasons.push('location_incompatible');
  if (!input.contractCompatible) hardRejectReasons.push('contract_incompatible');
  if (input.workAuthorisationCompatible === false) {
    hardRejectReasons.push('work_authorisation_incompatible');
  }
  if (salaryGate === 'reject') hardRejectReasons.push('salary_below_floor');

  const matchByRequirement = new Map(
    input.requirements.map((requirement) => [requirement.requirementId, requirement]),
  );
  for (const requirementId of input.mandatoryRequirementIds) {
    const requirement = matchByRequirement.get(requirementId);
    if (requirement?.outcome === 'not_met') {
      hardRejectReasons.push(`mandatory_not_met:${requirementId}`);
    } else if (requirement?.outcome !== 'met') {
      autoBlockers.push(`mandatory_unknown:${requirementId}`);
    }
  }

  if (salaryGate !== 'pass') autoBlockers.push(`salary_${salaryGate}`);
  if (input.workAuthorisationCompatible === 'unknown') {
    autoBlockers.push('work_authorisation_unknown');
  }
  if (input.sitePolicy !== 'auto_submit_allowed') {
    autoBlockers.push(`site_policy_${input.sitePolicy}`);
  }
  if (input.personSpecification === 'unreadable') {
    autoBlockers.push('person_specification_unreadable');
    explanation.push(
      'The advert links a criteria document that could not be read safely, so its essential requirements are unknown.',
    );
  }
  if (input.mandatoryCriteriaVisible === false) {
    autoBlockers.push('no_mandatory_criteria_visible');
    explanation.push(
      'No essential requirements could be established from this advert, so none have been checked.',
    );
  }
  if (!input.dailyAutoSlotAvailable) autoBlockers.push('daily_cap_reached');
  if (!input.answersComplete) autoBlockers.push('answers_incomplete');
  if (input.humanOnlyStepPresent) autoBlockers.push('human_only_step');
  if (input.evidenceCoverage < config.matching.minimumEvidenceCoverageForAuto) {
    autoBlockers.push('insufficient_evidence_coverage');
  }
  if (input.decisionConfidence < config.matching.minimumDecisionConfidenceForAuto) {
    autoBlockers.push('insufficient_decision_confidence');
  }
  if (!config.submission.autoEnabled) autoBlockers.push('auto_submit_disabled');

  if (hardRejectReasons.length > 0) {
    explanation.push('One or more deterministic hard gates failed.');
    return {
      action: 'reject',
      score,
      evidenceCoverage: input.evidenceCoverage,
      decisionConfidence: input.decisionConfidence,
      hardRejectReasons,
      autoBlockers,
      explanation,
    };
  }

  // An advert that links criteria the agent could not read must not be discarded on a score that
  // was calculated without them. It is surfaced for review instead, with the reason attached.
  if (input.personSpecification === 'unreadable' && score < config.matching.thresholds.shortlist) {
    explanation.push(
      'Kept for your review rather than rejected, because the score was calculated without criteria the agent could not read.',
    );
    return {
      action: 'shortlist',
      score,
      evidenceCoverage: input.evidenceCoverage,
      decisionConfidence: input.decisionConfidence,
      hardRejectReasons,
      autoBlockers,
      explanation,
    };
  }

  if (score < config.matching.thresholds.shortlist) {
    explanation.push('Score is below the shortlist threshold.');
    return {
      action: 'reject',
      score,
      evidenceCoverage: input.evidenceCoverage,
      decisionConfidence: input.decisionConfidence,
      hardRejectReasons,
      autoBlockers,
      explanation,
    };
  }

  if (score < config.matching.thresholds.approvalPrefill) {
    explanation.push('Score is in the user-review shortlist band.');
    return {
      action: 'shortlist',
      score,
      evidenceCoverage: input.evidenceCoverage,
      decisionConfidence: input.decisionConfidence,
      hardRejectReasons,
      autoBlockers,
      explanation,
    };
  }

  if (score >= config.matching.thresholds.autoCandidate && autoBlockers.length === 0) {
    explanation.push('High-match threshold and every automatic policy gate passed.');
    return {
      action: 'auto_apply',
      score,
      evidenceCoverage: input.evidenceCoverage,
      decisionConfidence: input.decisionConfidence,
      hardRejectReasons,
      autoBlockers,
      explanation,
    };
  }

  explanation.push(
    score >= config.matching.thresholds.autoCandidate
      ? 'High match, but automatic progression is blocked by one or more safety policies.'
      : 'Score is in the prefill-with-approval band.',
  );
  return {
    action: 'prefill_with_approval',
    score,
    evidenceCoverage: input.evidenceCoverage,
    decisionConfidence: input.decisionConfidence,
    hardRejectReasons,
    autoBlockers,
    explanation,
  };
}

export * from './shadow.js';
