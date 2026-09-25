import { z } from 'zod';

import {
  fetchMyJobScotlandJob,
  type CriteriaReadOptions,
  type DiscoveredJob,
} from './myjobscotland.js';

/** Scheduled polling never runs more often than this, whatever the configuration asks for. */
export const MINIMUM_SCHEDULE_INTERVAL_SECONDS = 900;

export const sourceAdapterTypes = ['manual_url_list', 'public_feed'] as const;
export type SourceAdapterType = (typeof sourceAdapterTypes)[number];

export type JobDetailFetcher = (
  url: string,
  fetcher?: typeof fetch,
  criteria?: CriteriaReadOptions,
) => Promise<DiscoveredJob>;

/**
 * Only a domain with a reviewed, purpose-written public parser can be discovered. This is what
 * stops a new source from turning into ad-hoc scraping of an unreviewed site.
 */
const detailFetchers = new Map<string, JobDetailFetcher>([
  ['myjobscotland.gov.uk', fetchMyJobScotlandJob],
]);

export function detailFetcherForDomain(domain: string): JobDetailFetcher | null {
  return detailFetchers.get(domain.toLowerCase()) ?? null;
}

export function supportedDiscoveryDomains(): string[] {
  return [...detailFetchers.keys()].sort((left, right) => left.localeCompare(right));
}

const httpsUrl = z.url().startsWith('https://').max(2048);

export const sourceDefinitionSchema = z
  .object({
    key: z
      .string()
      .min(3)
      .max(48)
      .regex(
        /^[a-z][a-z0-9_-]*$/,
        'Source key must be lowercase letters, digits, dash or underscore',
      ),
    displayName: z.string().min(1).max(80),
    adapterType: z.enum(sourceAdapterTypes),
    sitePolicyDomain: z
      .string()
      .min(3)
      .regex(/^[a-z0-9.-]+$/, 'Domain must be a lowercase hostname'),
    feedUrl: httpsUrl.optional(),
    manualUrls: z.array(httpsUrl).max(200).default([]),
    enabled: z.boolean().default(false),
    scheduleIntervalSeconds: z
      .number()
      .int()
      .min(MINIMUM_SCHEDULE_INTERVAL_SECONDS)
      .max(604_800)
      .default(21_600),
    maxItemsPerRun: z.number().int().min(1).max(200).default(25),
    reviewedBy: z.string().min(1).max(120),
    reviewedAt: z.iso.datetime({ offset: true }),
    notes: z.string().max(2000).optional(),
  })
  .superRefine((source, context) => {
    if (source.adapterType === 'public_feed' && source.feedUrl === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['feedUrl'],
        message:
          'A feed source needs an explicit, documented feed URL. The agent will not look for one.',
      });
    }
    if (source.adapterType === 'public_feed' && source.manualUrls.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['manualUrls'],
        message: 'A feed source must not also carry a manual URL list.',
      });
    }
    if (detailFetcherForDomain(source.sitePolicyDomain) === null) {
      context.addIssue({
        code: 'custom',
        path: ['sitePolicyDomain'],
        message: `No reviewed public parser exists for ${source.sitePolicyDomain}.`,
      });
    }
  });

export type SourceDefinition = z.infer<typeof sourceDefinitionSchema>;

/**
 * Shipped defaults. Every source starts disabled, so a fresh install performs no scheduled
 * network activity until the user reviews and enables something.
 */
export const defaultSourceDefinitions: readonly SourceDefinition[] = [
  sourceDefinitionSchema.parse({
    key: 'myjobscotland_manual',
    displayName: 'MyJobScotland saved vacancy links',
    adapterType: 'manual_url_list',
    sitePolicyDomain: 'myjobscotland.gov.uk',
    manualUrls: [],
    enabled: false,
    scheduleIntervalSeconds: 21_600,
    maxItemsPerRun: 25,
    reviewedBy: 'system',
    reviewedAt: '2026-01-01T00:00:00.000Z',
    notes:
      'Re-checks vacancy links you have added, so closures and changes are noticed. Add links on the tracker page.',
  } satisfies Record<string, unknown>),
];

export function scheduleIntervalOrMinimum(seconds: number | null | undefined): number {
  if (seconds === null || seconds === undefined) return 21_600;
  return Math.max(MINIMUM_SCHEDULE_INTERVAL_SECONDS, Math.trunc(seconds));
}
