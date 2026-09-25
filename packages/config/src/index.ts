import { z } from 'zod';

const thresholdSchema = z
  .object({
    autoCandidate: z.number().int().min(0).max(100),
    approvalPrefill: z.number().int().min(0).max(100),
    shortlist: z.number().int().min(0).max(100),
  })
  .refine(
    ({ autoCandidate, approvalPrefill, shortlist }) =>
      shortlist < approvalPrefill && approvalPrefill < autoCandidate,
    'Thresholds must be strictly ordered: shortlist < approvalPrefill < autoCandidate',
  );

export const agentConfigSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    standalone: z.literal(true),
    timezone: z.string().min(1),
  }),
  matching: z.object({
    minimumSalary: z.object({
      amountMinor: z.number().int().nonnegative(),
      currency: z.literal('GBP'),
      basis: z.literal('annual_base'),
    }),
    thresholds: thresholdSchema,
    minimumEvidenceCoverageForAuto: z.number().min(0).max(1),
    minimumDecisionConfidenceForAuto: z.number().min(0).max(1),
  }),
  submission: z.object({
    defaultMode: z.enum(['approval_required', 'auto']),
    autoEnabled: z.boolean(),
    maxAutoPerLocalDay: z.number().int().positive().max(30),
    countUnknownOutcomeAgainstCap: z.literal(true),
    requireCurrentSitePolicy: z.literal(true),
    newDomains: z.literal('disabled'),
  }),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const defaultAgentConfig: AgentConfig = agentConfigSchema.parse({
  project: {
    name: 'job-application-agent',
    standalone: true,
    timezone: 'Europe/London',
  },
  matching: {
    minimumSalary: {
      amountMinor: 2_500_000,
      currency: 'GBP',
      basis: 'annual_base',
    },
    thresholds: {
      autoCandidate: 85,
      approvalPrefill: 70,
      shortlist: 50,
    },
    minimumEvidenceCoverageForAuto: 0.9,
    minimumDecisionConfidenceForAuto: 0.9,
  },
  submission: {
    defaultMode: 'approval_required',
    autoEnabled: false,
    maxAutoPerLocalDay: 30,
    countUnknownOutcomeAgainstCap: true,
    requireCurrentSitePolicy: true,
    newDomains: 'disabled',
  },
});
