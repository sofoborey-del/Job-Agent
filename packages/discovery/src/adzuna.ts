import { createHash } from 'node:crypto';

import { z } from 'zod';

/**
 * A reader for the documented Adzuna job search API.
 *
 * Why this source. Adzuna publishes a developer API with written terms that explicitly permit
 * personal research, published rate limits, and a free application key. That is a documented
 * permission a person can point at, which is what this project requires of a source. S1Jobs,
 * Totaljobs and Indeed publish no equivalent public search API for an individual job seeker, and
 * their pages are not scraped here.
 *
 * What it deliberately does not do. Adzuna's own documentation states that the search response
 * carries only "a snipped of the job description". A truncated description is not a person
 * specification, so every job from this source is marked `descriptionCompleteness: 'snippet'` and
 * the matcher then refuses to treat any criteria as established. Following `redirect_url` to read
 * the full advert would mean fetching an unreviewed third-party domain, which this source does not
 * do. Jobs arrive as leads to be opened by the person, not as scored matches.
 *
 * Credentials come from the environment and are never logged, never returned and never persisted.
 */

export const ADZUNA_API_HOST = 'api.adzuna.com';

/** The documented search endpoint. Adzuna documents http://; this client only ever uses https. */
export const ADZUNA_SEARCH_BASE = `https://${ADZUNA_API_HOST}/v1/api/jobs`;

/** Adzuna's published default allowance. The agent stays well inside it. */
export const ADZUNA_PUBLISHED_LIMITS = {
  perMinute: 25,
  perDay: 250,
  perWeek: 1000,
  perMonth: 2500,
} as const;

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const adzunaJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string().min(1).max(500),
  description: z.string().max(20_000).default(''),
  redirect_url: z.string().max(2048),
  created: z.string().max(80).optional(),
  salary_min: z.number().optional(),
  salary_max: z.number().optional(),
  salary_is_predicted: z.union([z.string(), z.number(), z.boolean()]).optional(),
  contract_type: z.string().max(80).optional(),
  contract_time: z.string().max(80).optional(),
  company: z.object({ display_name: z.string().max(300).optional() }).optional(),
  location: z
    .object({
      display_name: z.string().max(300).optional(),
      area: z.array(z.string().max(120)).max(20).optional(),
    })
    .optional(),
});

const adzunaResponseSchema = z.object({
  count: z.number().optional(),
  results: z.array(adzunaJobSchema).max(200),
});

export type AdzunaVacancy = {
  source: 'adzuna';
  externalId: string;
  canonicalUrl: string;
  title: string;
  employer: string;
  location: string;
  /** A snippet, never a full advert. See `descriptionCompleteness`. */
  description: string;
  /** Always 'snippet' for this source; the field exists so the matcher cannot forget. */
  descriptionCompleteness: 'snippet';
  salary: {
    minimumMinor?: number;
    maximumMinor?: number;
    currency: 'GBP';
    basis: 'annual_base' | 'unknown';
    confidence: number;
    sourceText: string;
  } | null;
  employmentTypes: string[];
  contractType: string | null;
  publishedAt: string | null;
  contentHash: string;
};

export type AdzunaCredentials = { appId: string; appKey: string };

export type AdzunaSearchOptions = {
  credentials: AdzunaCredentials;
  /** Free-text search, e.g. the user's target roles. */
  what?: string;
  /** Place name, e.g. "Glasgow". */
  where?: string;
  /** Adzuna's own country code; this agent only uses 'gb'. */
  country?: 'gb';
  maxItems?: number;
  /**
   * The configured salary floor, passed to Adzuna so below-floor adverts are not retrieved at all.
   * This is a courtesy filter only: the deterministic salary gate still runs on every result.
   */
  minimumAnnualSalary?: number;
  fetcher?: typeof fetch;
  userAgent?: string;
};

function pounds(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value * 100);
}

function isPredicted(value: unknown): boolean {
  return value === '1' || value === 1 || value === true;
}

/** Builds the request URL. Credentials go in the query because Adzuna documents no other way. */
export function adzunaSearchUrl(options: AdzunaSearchOptions, page = 1): string {
  const country = options.country ?? 'gb';
  const url = new URL(`${ADZUNA_SEARCH_BASE}/${country}/search/${String(page)}`);
  url.searchParams.set('app_id', options.credentials.appId);
  url.searchParams.set('app_key', options.credentials.appKey);
  url.searchParams.set('results_per_page', String(Math.min(options.maxItems ?? 25, 50)));
  url.searchParams.set('content-type', 'application/json');
  if (options.what !== undefined && options.what !== '') url.searchParams.set('what', options.what);
  if (options.where !== undefined && options.where !== '') {
    url.searchParams.set('where', options.where);
  }
  if (options.minimumAnnualSalary !== undefined) {
    url.searchParams.set('salary_min', String(options.minimumAnnualSalary));
  }
  return url.toString();
}

/** Strips credentials from a URL so it can be logged or reported safely. */
export function redactAdzunaUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const name of ['app_id', 'app_key']) {
      if (parsed.searchParams.has(name)) parsed.searchParams.set(name, 'REDACTED');
    }
    return parsed.toString();
  } catch {
    return 'invalid-url';
  }
}

export function mapAdzunaJob(raw: z.infer<typeof adzunaJobSchema>): AdzunaVacancy | null {
  let redirect: URL;
  try {
    redirect = new URL(raw.redirect_url);
  } catch {
    return null;
  }
  if (redirect.protocol !== 'https:') return null;

  const minimum = pounds(raw.salary_min);
  const maximum = pounds(raw.salary_max);
  const predicted = isPredicted(raw.salary_is_predicted);
  const description = raw.description.trim();

  const vacancy: AdzunaVacancy = {
    source: 'adzuna',
    externalId: String(raw.id),
    canonicalUrl: redirect.toString(),
    title: raw.title.trim(),
    employer: raw.company?.display_name?.trim() ?? 'Not stated',
    location: raw.location?.display_name?.trim() ?? 'Not stated',
    description,
    descriptionCompleteness: 'snippet',
    salary:
      minimum === undefined && maximum === undefined
        ? null
        : {
            ...(minimum === undefined ? {} : { minimumMinor: minimum }),
            ...(maximum === undefined ? {} : { maximumMinor: maximum }),
            currency: 'GBP',
            // A predicted salary is Adzuna's estimate, not the employer's statement, so it is
            // never treated as a stated salary and carries low confidence.
            basis: predicted ? ('unknown' as const) : ('annual_base' as const),
            confidence: predicted ? 0.2 : 0.8,
            sourceText: predicted ? 'Adzuna salary estimate, not stated by the employer' : 'Adzuna',
          },
    employmentTypes: [raw.contract_time, raw.contract_type].filter(
      (value): value is string => typeof value === 'string' && value !== '',
    ),
    contractType: raw.contract_type ?? null,
    publishedAt:
      raw.created === undefined || Number.isNaN(new Date(raw.created).getTime())
        ? null
        : new Date(raw.created).toISOString(),
    contentHash: '',
  };

  vacancy.contentHash = createHash('sha256')
    .update(
      JSON.stringify([
        vacancy.externalId,
        vacancy.title,
        vacancy.employer,
        vacancy.location,
        vacancy.description,
        vacancy.salary,
        vacancy.contractType,
      ]),
    )
    .digest('hex');
  return vacancy;
}

export function parseAdzunaResponse(body: unknown): AdzunaVacancy[] {
  const parsed = adzunaResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error('The Adzuna response did not match the documented shape');
  const seen = new Set<string>();
  const vacancies: AdzunaVacancy[] = [];
  for (const raw of parsed.data.results) {
    const vacancy = mapAdzunaJob(raw);
    if (vacancy === null || seen.has(vacancy.externalId)) continue;
    seen.add(vacancy.externalId);
    vacancies.push(vacancy);
  }
  return vacancies;
}

/**
 * Performs one search. Read-only: it sends no applicant value, follows no redirect, and reads
 * nothing beyond the documented endpoint.
 */
export async function fetchAdzunaVacancies(options: AdzunaSearchOptions): Promise<AdzunaVacancy[]> {
  if (options.credentials.appId === '' || options.credentials.appKey === '') {
    throw new Error('Adzuna credentials are not configured; this source stays switched off');
  }
  const url = adzunaSearchUrl(options);
  if (new URL(url).hostname !== ADZUNA_API_HOST) {
    throw new Error('Refusing to call a host other than the documented Adzuna API');
  }

  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(url, {
    redirect: 'manual',
    headers: {
      accept: 'application/json',
      'user-agent': options.userAgent ?? 'JobApplicationAgent/0.1 personal-read-only-discovery',
    },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error('The Adzuna endpoint redirected; the documented endpoint should not');
  }
  if (!response.ok) {
    // The URL is redacted: it carries the application key.
    throw new Error(`Adzuna returned HTTP ${String(response.status)} for ${redactAdzunaUrl(url)}`);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) throw new Error('Adzuna response is too large');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('Adzuna response is too large');
  }
  return parseAdzunaResponse(JSON.parse(text));
}
