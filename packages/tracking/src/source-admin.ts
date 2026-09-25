import { detailFetcherForDomain, type SourceDefinition } from '@job-agent/discovery';
import { discoveryPermitted, evaluateSitePolicy } from '@job-agent/policy';

import type { SitePolicyLookup } from './discovery-service.js';
import type { TrackingStores } from './ports.js';
import type { SourceRecord } from './types.js';

export type SourceCheckSubject = {
  sourceKey: string;
  adapterType: SourceRecord['adapterType'];
  sitePolicyDomain: string;
  feedUrl: string | null;
  manualUrls: string[];
};

export type SourceCheckResult =
  | { allowed: true; warnings: string[] }
  | { allowed: false; reason: string; message: string; warnings: string[] };

function subjectFromRecord(source: SourceRecord): SourceCheckSubject {
  return {
    sourceKey: source.sourceKey,
    adapterType: source.adapterType,
    sitePolicyDomain: source.sitePolicyDomain,
    feedUrl: source.feedUrl,
    manualUrls: source.manualUrls,
  };
}

function subjectFromDefinition(definition: SourceDefinition): SourceCheckSubject {
  return {
    sourceKey: definition.key,
    adapterType: definition.adapterType,
    sitePolicyDomain: definition.sitePolicyDomain,
    feedUrl: definition.feedUrl ?? null,
    manualUrls: definition.manualUrls,
  };
}

/**
 * Everything that must be true before a source may be switched on. Each check fails closed with a
 * reason the user can act on, and the same checks run again at discovery time so a policy that
 * expires after a source was enabled still stops the next run.
 */
export async function checkSourceMayBeEnabled(
  subject: SourceCheckSubject,
  sitePolicyFor: SitePolicyLookup,
  now = new Date(),
): Promise<SourceCheckResult> {
  const warnings: string[] = [];

  if (detailFetcherForDomain(subject.sitePolicyDomain) === null) {
    return {
      allowed: false,
      reason: 'no_reviewed_parser',
      message: `This project has no reviewed reader for ${subject.sitePolicyDomain}, so it cannot read adverts from that site. Only sites with a purpose-written reader can be switched on.`,
      warnings,
    };
  }

  const policy = await sitePolicyFor(subject.sitePolicyDomain);
  if (policy === null) {
    return {
      allowed: false,
      reason: 'site_policy_missing',
      message: `There is no reviewed site policy for ${subject.sitePolicyDomain}. Record one, with the terms you checked and the date you checked them, before switching this source on.`,
      warnings,
    };
  }

  const evaluation = evaluateSitePolicy(policy, now);
  if (evaluation.decision === 'expired') {
    return {
      allowed: false,
      reason: 'site_policy_expired',
      message: `The site policy review for ${policy.domain} ran out on ${policy.reviewExpiresAt.slice(0, 10)}. Check the site's terms again and record a new review before switching this source on.`,
      warnings,
    };
  }
  if (evaluation.decision === 'disabled') {
    return {
      allowed: false,
      reason: 'site_policy_disabled',
      message: `The reviewed policy for ${policy.domain} does not allow this agent to read that site${evaluation.reasons.includes('terms_prohibit_automation') ? ', because its terms prohibit automated access' : ''}.`,
      warnings,
    };
  }
  if (evaluation.decision === 'unknown') {
    return {
      allowed: false,
      reason: 'site_policy_unknown',
      message: `The terms for ${policy.domain} have not been reviewed yet, so the agent treats the site as not permitted.`,
      warnings,
    };
  }

  const action = subject.adapterType === 'public_feed' ? 'feed' : 'manual_url';
  const permission = discoveryPermitted(policy, action, now);
  if (!permission.allowed) {
    return {
      allowed: false,
      reason: permission.reason,
      message:
        action === 'feed'
          ? `The reviewed policy for ${policy.domain} does not cover polling a feed. Update the site policy to say that a documented feed may be read, or use saved vacancy links instead.`
          : `The reviewed policy for ${policy.domain} does not permit reading vacancy pages.`,
      warnings,
    };
  }

  if (
    subject.adapterType === 'public_feed' &&
    (subject.feedUrl === null || subject.feedUrl === '')
  ) {
    return {
      allowed: false,
      reason: 'feed_url_missing',
      message:
        'This feed source has no feed address. Add the documented feed address from the site before switching it on. The agent will not look for one.',
      warnings,
    };
  }

  if (subject.adapterType === 'manual_url_list' && subject.manualUrls.length === 0) {
    warnings.push(
      'This source has no saved vacancy links yet, so scheduled runs will find nothing until you add some.',
    );
  }

  return { allowed: true, warnings };
}

export class SourceEnableRefusedError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'SourceEnableRefusedError';
  }
}

export type SourceAdminOptions = {
  stores: TrackingStores;
  sitePolicyFor: SitePolicyLookup;
};

/** Switching a source on is a policy decision, so it goes through these checks rather than the store. */
export class SourceAdminService {
  constructor(private readonly options: SourceAdminOptions) {}

  async validateRecord(source: SourceRecord, now = new Date()): Promise<SourceCheckResult> {
    return checkSourceMayBeEnabled(subjectFromRecord(source), this.options.sitePolicyFor, now);
  }

  async validateDefinition(
    definition: SourceDefinition,
    now = new Date(),
  ): Promise<SourceCheckResult> {
    return checkSourceMayBeEnabled(
      subjectFromDefinition(definition),
      this.options.sitePolicyFor,
      now,
    );
  }

  async setEnabled(input: {
    sourceKey: string;
    enabled: boolean;
    reason?: string | null;
    now?: Date;
  }): Promise<{ source: SourceRecord; warnings: string[] }> {
    const now = input.now ?? new Date();
    const source = await this.options.stores.sources.getByKey(input.sourceKey);
    if (source === null) {
      throw new SourceEnableRefusedError('source_not_found', 'That source does not exist.');
    }
    if (!input.enabled) {
      return {
        source: await this.options.stores.sources.setEnabled(
          input.sourceKey,
          false,
          input.reason ?? 'switched off by the user',
        ),
        warnings: [],
      };
    }
    const check = await this.validateRecord(source, now);
    if (!check.allowed) throw new SourceEnableRefusedError(check.reason, check.message);
    return {
      source: await this.options.stores.sources.setEnabled(
        input.sourceKey,
        true,
        input.reason ?? null,
      ),
      warnings: check.warnings,
    };
  }

  /** Upserts a definition, refusing to store it already enabled unless every check passes. */
  async upsertDefinition(
    definition: SourceDefinition,
    now = new Date(),
  ): Promise<{ source: SourceRecord; warnings: string[] }> {
    if (definition.enabled) {
      const check = await this.validateDefinition(definition, now);
      if (!check.allowed) throw new SourceEnableRefusedError(check.reason, check.message);
      return {
        source: await this.options.stores.sources.upsertDefinition(definition, now),
        warnings: check.warnings,
      };
    }
    return {
      source: await this.options.stores.sources.upsertDefinition(definition, now),
      warnings: [],
    };
  }
}
