import type { KnowledgeFact } from '@job-agent/domain';
import { findMissingProfileCategories } from '@job-agent/knowledge-base';

import type { SitePolicyLookup } from './discovery-service.js';
import type { TrackingStores } from './ports.js';
import { checkSourceMayBeEnabled } from './source-admin.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReadinessProblem = {
  code: string;
  message: string;
};

export type SchedulerReadiness = {
  ready: boolean;
  problems: ReadinessProblem[];
  enabledSources: number;
  checkedAt: string;
};

export type ReadinessOptions = {
  stores: TrackingStores;
  userId: string;
  sitePolicyFor: SitePolicyLookup;
  loadFacts: () => Promise<readonly KnowledgeFact<unknown>[]>;
};

/**
 * Everything the background scheduler needs before it may do any work. A failed check is reported
 * as a status the user can read and fix; the scheduler then stays idle rather than retrying a run
 * that cannot succeed.
 */
export class SchedulerReadinessService {
  constructor(private readonly options: ReadinessOptions) {}

  async check(now = new Date()): Promise<SchedulerReadiness> {
    const problems: ReadinessProblem[] = [];
    const checkedAt = now.toISOString();

    if (!uuidPattern.test(this.options.userId)) {
      return {
        ready: false,
        enabledSources: 0,
        checkedAt,
        problems: [
          {
            code: 'agent_user_id_invalid',
            message:
              'AGENT_USER_ID is not a valid profile ID. Copy the profile ID shown on the onboarding page into .env, then restart the service.',
          },
        ],
      };
    }

    if (!(await this.options.stores.users.exists(this.options.userId))) {
      return {
        ready: false,
        enabledSources: 0,
        checkedAt,
        problems: [
          {
            code: 'agent_user_not_found',
            message:
              'No profile exists with that AGENT_USER_ID. Create the profile at /onboarding, then put its ID in .env and restart the service.',
          },
        ],
      };
    }

    let facts: readonly KnowledgeFact<unknown>[] = [];
    try {
      facts = await this.options.loadFacts();
    } catch {
      problems.push({
        code: 'profile_unreadable',
        message: 'The saved profile could not be read. Check the encryption settings in .env.',
      });
    }
    const missingCategories = findMissingProfileCategories(facts);
    if (missingCategories.length > 0) {
      problems.push({
        code: 'profile_incomplete',
        message: `Finish the profile before scheduled searching starts. Still needed: ${missingCategories.join(', ')}.`,
      });
    }

    const sources = await this.options.stores.sources.list();
    const enabled = sources.filter((source) => source.enabled);
    if (enabled.length === 0) {
      problems.push({
        code: 'no_enabled_source',
        message:
          'No source is switched on, so there is nothing to search. Switch one on from the tracker page once its site policy is recorded.',
      });
    }
    for (const source of enabled) {
      const check = await checkSourceMayBeEnabled(
        {
          sourceKey: source.sourceKey,
          adapterType: source.adapterType,
          sitePolicyDomain: source.sitePolicyDomain,
          feedUrl: source.feedUrl,
          manualUrls: source.manualUrls,
        },
        this.options.sitePolicyFor,
        now,
      );
      if (!check.allowed) {
        problems.push({
          code: `source_invalid:${source.sourceKey}`,
          message: `The source "${source.displayName}" is switched on but cannot run: ${check.message}`,
        });
      }
    }

    return { ready: problems.length === 0, problems, enabledSources: enabled.length, checkedAt };
  }
}
