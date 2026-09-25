import { defaultAgentConfig } from '@job-agent/config';
import { decideMatch } from '@job-agent/matching';

const decision = decideMatch(
  {
    salary: {
      basis: 'annual_base',
      minimum: { amountMinor: 3_000_000, currency: 'GBP' },
      maximum: { amountMinor: 3_300_000, currency: 'GBP' },
      confidence: 0.99,
      sourceText: '£30,000–£33,000',
    },
    requirements: [
      {
        requirementId: 'customer-service',
        outcome: 'met',
        evidenceFactIds: ['synthetic-employment-1'],
        confidence: 0.98,
        explanation: 'Verified synthetic employment evidence.',
      },
    ],
    mandatoryRequirementIds: ['customer-service'],
    dimensions: {
      mandatoryCoverage: 1,
      relevantSkills: 0.95,
      relevantExperience: 0.9,
      locationFit: 1,
      compensationQuality: 1,
      otherPreferences: 1,
    },
    preferredCriteriaNotMet: 0,
    weakEvidenceCount: 0,
    evidenceCoverage: 0.96,
    decisionConfidence: 0.97,
    locationCompatible: true,
    contractCompatible: true,
    workAuthorisationCompatible: true,
    excluded: false,
    duplicateApplication: false,
    jobOpen: true,
    sitePolicy: 'prefill_only',
    dailyAutoSlotAvailable: true,
    answersComplete: false,
    humanOnlyStepPresent: false,
  },
  defaultAgentConfig,
);

console.log(
  JSON.stringify(
    {
      synthetic: true,
      policy: {
        minimumSalaryGbp: defaultAgentConfig.matching.minimumSalary.amountMinor / 100,
        maxAutoPerDay: defaultAgentConfig.submission.maxAutoPerLocalDay,
        autoSubmitEnabled: defaultAgentConfig.submission.autoEnabled,
      },
      decision,
    },
    null,
    2,
  ),
);
