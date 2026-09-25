import { z } from 'zod';

export const adapterStepSchema = z.object({
  id: z.string().min(1).max(80),
  path: z.string().min(1).max(400),
  humanOnly: z.boolean().default(false),
  nextSelector: z.string().max(400).optional(),
  submitSelector: z.string().max(400).optional(),
  repeatable: z.boolean().default(false),
});
export type AdapterStep = z.infer<typeof adapterStepSchema>;

export const adapterContractSchema = z.object({
  id: z.string().min(1).max(60),
  version: z.string().min(1).max(40),
  /** Loopback only. A production host can never appear here; the validator enforces that too. */
  targetOrigin: z.string().min(1).max(200),
  allowsSubmit: z.literal(true),
  isFakeTarget: z.literal(true),
  steps: z.array(adapterStepSchema).min(1).max(40),
  confirmationPath: z.string().min(1).max(400),
  confirmationReferencePattern: z.string().min(1).max(200),
});
export type AdapterContract = z.infer<typeof adapterContractSchema>;

export function stepById(adapter: AdapterContract, stepId: string): AdapterStep | null {
  return adapter.steps.find((step) => step.id === stepId) ?? null;
}

export function humanOnlyStepIds(adapter: AdapterContract): string[] {
  return adapter.steps.filter((step) => step.humanOnly).map((step) => step.id);
}
