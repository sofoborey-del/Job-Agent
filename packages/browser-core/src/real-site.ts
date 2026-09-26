import { z } from 'zod';

import type { BrowserAction } from './actions.js';
import type { FieldIntent } from './inventory.js';

/**
 * The contract for an adapter that points at a real employer site.
 *
 * This is deliberately a separate type from `AdapterContract`, not an extension of it. The fake
 * contract fixes `allowsSubmit: true` and `isFakeTarget: true`; this one fixes both to false, so a
 * real target can never be passed where a fake one is expected and the fake adapter can never be
 * pointed at a production host. Nothing here relaxes the loopback rule the fake validator applies.
 *
 * Every real-site adapter is prefill-only. There is no submit action, no declaration action and no
 * consent action in this path, and `executionMode` starts disabled so that merely defining an
 * adapter enables nothing.
 */

export const realSiteExecutionModes = ['disabled', 'prefill_only'] as const;
export type RealSiteExecutionMode = (typeof realSiteExecutionModes)[number];

/** A registrable domain or host the adapter may visit. Compared case-insensitively. */
const hostname = z
  .string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i);

export const realSiteStepSchema = z.object({
  id: z.string().min(1).max(80),
  /** Human-readable description of where this step sits in the employer's flow. */
  description: z.string().min(1).max(200),
  /** Steps the agent may fill. A human-only step is observed and handed straight to the user. */
  humanOnly: z.boolean().default(false),
  /** Present only on steps the agent may advance past. Never a submit control. */
  nextSelector: z.string().max(400).optional(),
});
export type RealSiteStep = z.infer<typeof realSiteStepSchema>;

export const realSiteAdapterSchema = z.object({
  id: z.string().min(1).max(60),
  version: z.string().min(1).max(40),
  /** Shown to the user so they know which employer system this describes. */
  providerName: z.string().min(1).max(120),
  /** Exact hosts, or parents of hosts, the adapter may navigate to. HTTPS only, always. */
  approvedDomains: z.array(hostname).min(1).max(20),
  /** Disabled until a site policy and a user decision say otherwise. */
  executionMode: z.enum(realSiteExecutionModes).default('disabled'),
  /** Structural, not configurable: this path cannot submit and is not a test target. */
  allowsSubmit: z.literal(false),
  isFakeTarget: z.literal(false),
  /** The user signs in themselves. The agent never handles credentials, MFA or CAPTCHA. */
  requiresUserAuthentication: z.literal(true),
  steps: z.array(realSiteStepSchema).min(1).max(40),
});
export type RealSiteAdapter = z.infer<typeof realSiteAdapterSchema>;

/**
 * Field intents the agent will never fill on a real site, whatever the page says and whatever a
 * fact store happens to contain. Equality monitoring, declarations and consent belong to the
 * person, and a criminal-record or disability answer is theirs to give.
 */
export const realSiteHumanOnlyIntents: ReadonlySet<FieldIntent> = new Set<FieldIntent>([
  'sensitive.disability',
  'sensitive.criminal_record',
  'sensitive.diversity',
  'declaration.truth',
]);

export type RealSiteRefusal = { allowed: false; code: string; message: string };
export type RealSiteApproval = { allowed: true };
export type RealSiteDecision = RealSiteApproval | RealSiteRefusal;

function refuse(code: string, message: string): RealSiteRefusal {
  return { allowed: false, code, message };
}

/** HTTPS, and a host that is an approved domain or a subdomain of one. Nothing else. */
export function isApprovedRealSiteUrl(url: string, approvedDomains: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return approvedDomains.some((domain) => {
    const approved = domain.toLowerCase();
    return host === approved || host.endsWith(`.${approved}`);
  });
}

export type RealSiteValidationInput = {
  adapter: RealSiteAdapter;
  action: BrowserAction;
  /** The step the worker believes it is on, taken from the page it just inspected. */
  currentStepId: string;
  /** Intents the mapper assigned on this page, by field key. */
  intents: Readonly<Record<string, FieldIntent>>;
  /** Whether the reviewed site policy currently permits prefill on this domain. */
  sitePolicyPermitsPrefill: boolean;
  /** Set once the user has confirmed they are signed in and have finished any challenge. */
  userAuthenticated: boolean;
};

/**
 * Decides whether one proposed action may run against a real employer site.
 *
 * It fails closed on every unknown: an unrecognised step, an unmapped field, an action kind this
 * path does not support. A model may propose actions; only this function lets them through, and it
 * never lets a submit through at all.
 */
export function validateRealSiteAction(input: RealSiteValidationInput): RealSiteDecision {
  const { adapter, action } = input;

  if (adapter.executionMode !== 'prefill_only') {
    return refuse(
      'execution_disabled',
      'This adapter is not switched on for prefill. Nothing was done.',
    );
  }
  if (!input.sitePolicyPermitsPrefill) {
    return refuse(
      'site_policy_forbids_prefill',
      'The reviewed site policy for this domain does not permit prefill.',
    );
  }
  if (!input.userAuthenticated) {
    return refuse(
      'user_not_authenticated',
      'Sign in yourself first. The agent does not handle login, MFA or CAPTCHA.',
    );
  }

  // Submit never reaches a real site from this path, at any execution mode, under any policy.
  if (action.kind === 'submit') {
    return refuse(
      'submit_forbidden_on_real_site',
      'This adapter cannot submit. You send the application yourself.',
    );
  }

  const step = adapter.steps.find((candidate) => candidate.id === input.currentStepId);
  if (step === undefined) {
    return refuse(
      'unknown_step',
      'The page does not match a known step in this application flow. The agent stopped.',
    );
  }

  if (action.kind === 'navigate') {
    if (!isApprovedRealSiteUrl(action.url, adapter.approvedDomains)) {
      return refuse(
        'destination_not_approved',
        'That address is not an approved application domain over HTTPS.',
      );
    }
    return { allowed: true };
  }

  if (action.kind === 'request_user' || action.kind === 'capture_review') {
    return { allowed: true };
  }

  if (action.kind === 'click_next') {
    if (step.humanOnly) {
      return refuse('human_only_step', 'Only you may work on this step.');
    }
    if (step.nextSelector === undefined || step.nextSelector !== action.selector) {
      return refuse(
        'unexpected_control',
        'That is not the recorded control for moving on from this step.',
      );
    }
    return { allowed: true };
  }

  // Only the fill-like actions remain: fill, select, check and upload.
  {
    if (step.humanOnly) {
      return refuse(
        'human_only_step',
        'This step holds questions only you may answer. The agent filled nothing.',
      );
    }
    const intent = input.intents[action.fieldKey];
    if (intent === undefined || intent === 'unknown') {
      return refuse(
        'unmapped_field',
        'That field was not recognised, so the agent will ask you rather than guess.',
      );
    }
    if (realSiteHumanOnlyIntents.has(intent)) {
      return refuse(
        'human_only_field',
        'That question is yours to answer. The agent will not fill it.',
      );
    }
    return { allowed: true };
  }
}
