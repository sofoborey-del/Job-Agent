import { detailFetcherForDomain, normaliseDiscoveredJob } from '@job-agent/discovery';
import { discoveryPermitted, type SitePolicy } from '@job-agent/policy';

/**
 * Turning an incomplete discovery lead into a complete, scoreable job.
 *
 * An aggregator gives an excerpt and a redirect. The excerpt cannot establish criteria, and the
 * redirect points wherever the aggregator chooses, so neither is a route to a full advert. The only
 * safe route is the person telling the agent the official employer address, and the agent reading
 * it **only** when that exact domain already has both a reviewed site policy and a purpose-built
 * reader written for it.
 *
 * Every refusal below happens before any network request. A domain the agent has not had reviewed
 * is never fetched, not even to find out whether it would have worked.
 */

export const leadCompletionRefusals = [
  'not_https',
  'url_has_credentials',
  'no_site_policy',
  'policy_forbids_discovery',
  'no_reviewed_reader',
  'lead_not_found',
  'lead_already_complete',
  'same_as_lead_url',
] as const;
export type LeadCompletionRefusal = (typeof leadCompletionRefusals)[number];

export type LeadCompletionCheck =
  | { allowed: true; domain: string; policy: SitePolicy }
  | { allowed: false; reason: LeadCompletionRefusal; domain: string | null; message: string };

type SitePolicyLookup = (domain: string) => Promise<SitePolicy | null>;

/**
 * Walks a hostname up to its registrable parent, so a policy written for `myjobscotland.gov.uk`
 * also covers `www.myjobscotland.gov.uk`. It never walks past a two-label suffix, so a policy is
 * never matched from a public suffix such as `gov.uk`.
 */
export function candidateDomains(hostname: string): string[] {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
  const candidates: string[] = [];
  for (let index = 0; index + 2 <= labels.length; index += 1) {
    const candidate = labels.slice(index).join('.');
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * Decides whether the agent may read the address the person supplied.
 *
 * This is deliberately separate from the fetch, so a caller can show the person exactly why an
 * address was refused without anything having been requested.
 */
export async function checkOfficialUrl(input: {
  url: string;
  sitePolicyFor: SitePolicyLookup;
  now?: Date;
}): Promise<LeadCompletionCheck> {
  const now = input.now ?? new Date();

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return {
      allowed: false,
      reason: 'not_https',
      domain: null,
      message: 'That is not a web address.',
    };
  }
  if (parsed.protocol !== 'https:') {
    return {
      allowed: false,
      reason: 'not_https',
      domain: null,
      message: 'The address must start with https://.',
    };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      allowed: false,
      reason: 'url_has_credentials',
      domain: null,
      message: 'That address carries a username or password. The agent will not use it.',
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  for (const domain of candidateDomains(hostname)) {
    const policy = await input.sitePolicyFor(domain);
    if (policy === null) continue;

    const permission = discoveryPermitted(policy, 'manual_url', now);
    if (!permission.allowed) {
      return {
        allowed: false,
        reason: 'policy_forbids_discovery',
        domain,
        message: `The reviewed policy for ${domain} does not permit reading adverts (${permission.reason}).`,
      };
    }
    if (detailFetcherForDomain(domain) === null) {
      return {
        allowed: false,
        reason: 'no_reviewed_reader',
        domain,
        message: `There is a policy for ${domain} but no reader written for it, so nothing was fetched.`,
      };
    }
    return { allowed: true, domain, policy };
  }

  return {
    allowed: false,
    reason: 'no_site_policy',
    domain: hostname,
    message: `${hostname} has not been reviewed, so the agent will not open it. Open the advert yourself, or ask for that site to be reviewed.`,
  };
}

export { detailFetcherForDomain, normaliseDiscoveredJob };
