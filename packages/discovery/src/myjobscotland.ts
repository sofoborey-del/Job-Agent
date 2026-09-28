import { createHash } from 'node:crypto';

import type { MalwareScanner } from '@job-agent/document-safety';
import type { SitePolicy } from '@job-agent/policy';

import { readPersonSpecification, type PersonSpecificationRead } from './attachments.js';
import { canonicalizeJobUrl } from './canonical.js';

const ALLOWED_HOSTS = new Set(['myjobscotland.gov.uk', 'www.myjobscotland.gov.uk']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type DiscoveredJob = {
  descriptionCompleteness?: 'full' | 'snippet';
  source: 'myjobscotland' | 'adzuna';
  externalId: string;
  canonicalUrl: string;
  title: string;
  employer: string;
  location: string;
  description: string;
  salary: {
    minimumMinor?: number;
    maximumMinor?: number;
    currency: 'GBP';
    basis: 'annual_base' | 'hourly' | 'unknown';
    confidence: number;
    sourceText: string;
  } | null;
  employmentTypes: string[];
  contractType: string | null;
  hours: string | null;
  workPattern: string | null;
  publishedAt: string | null;
  closesAt: string | null;
  contentHash: string;
  /**
   * Criteria read from a document the advert links. Absent when no criteria-reading permission was
   * supplied, which leaves the pre-existing page-only behaviour untouched.
   */
  personSpecification?: PersonSpecificationRead;
};

/** Everything needed to read an advert's linked criteria. Omit it and no attachment is fetched. */
export type CriteriaReadOptions = {
  policy: SitePolicy;
  scanner: MalwareScanner;
  /** Honours the reviewed rate limit. Called once per outbound request. */
  beforeRequest?: () => Promise<void>;
  now?: Date;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function decodeEntities(value: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => entities[name.toLowerCase()] ?? match);
}

function plainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|dd|dt|h[1-6]|li|p|section)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function visibleLabel(html: string, label: string): string | null {
  const lines = plainText(html)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const target = label.toLocaleLowerCase('en-GB').replace(/:$/, '');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const normalised = line.toLocaleLowerCase('en-GB').replace(/:$/, '');
    if (normalised === target) return lines[index + 1] ?? null;
    if (normalised.startsWith(`${target}:`))
      return line.slice(line.indexOf(':') + 1).trim() || null;
  }
  return null;
}

function jobPostingFromHtml(html: string): UnknownRecord {
  const pattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const encoded = match[1];
    if (encoded === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      continue;
    }
    const root = record(parsed);
    const candidates = Array.isArray(root?.['@graph']) ? root['@graph'] : [parsed];
    for (const candidate of candidates) {
      const item = record(candidate);
      const type = item?.['@type'];
      if (
        item !== null &&
        (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting')))
      )
        return item;
    }
  }
  throw new Error('The page does not contain structured JobPosting data');
}

function moneyMinor(value: unknown): number | undefined {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric * 100) : undefined;
}

function salary(posting: UnknownRecord, html: string): DiscoveredJob['salary'] {
  const baseSalary = record(posting.baseSalary);
  const value = record(baseSalary?.value);
  const currency = text(baseSalary?.currency);
  const unit = text(value?.unitText)?.toUpperCase();
  const sourceText = visibleLabel(html, 'Salary') ?? visibleLabel(html, 'Rate') ?? '';
  if (currency !== 'GBP') return null;
  const basis = unit === 'YEAR' ? 'annual_base' : unit === 'HOUR' ? 'hourly' : 'unknown';
  const minimumMinor = moneyMinor(value?.minValue ?? value?.value);
  const maximumMinor = moneyMinor(value?.maxValue ?? value?.value);
  if (minimumMinor === undefined && maximumMinor === undefined) return null;
  return {
    ...(minimumMinor === undefined ? {} : { minimumMinor }),
    ...(maximumMinor === undefined ? {} : { maximumMinor }),
    currency: 'GBP',
    basis,
    confidence: basis === 'annual_base' ? 0.99 : 0.8,
    sourceText,
  };
}

function externalId(url: URL): string {
  const match = /-(\d+)$/.exec(url.pathname);
  if (match?.[1] === undefined) throw new Error('The MyJobScotland URL has no vacancy identifier');
  return match[1];
}

function assertAllowedUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Only HTTPS MyJobScotland job URLs are allowed');
  }
  if (!url.pathname.includes('/jobs/')) throw new Error('URL is not a MyJobScotland job page');
  return url;
}

async function fetchAllowedPage(
  rawUrl: string,
  fetcher: typeof fetch,
): Promise<{ html: string; url: URL }> {
  let url = assertAllowedUrl(rawUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetcher(url, {
      redirect: 'manual',
      headers: { 'user-agent': 'JobApplicationAgent/0.1 personal-read-only-discovery' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) throw new Error('MyJobScotland returned an invalid redirect');
      url = assertAllowedUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`MyJobScotland returned HTTP ${String(response.status)}`);
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength > MAX_RESPONSE_BYTES) throw new Error('MyJobScotland response is too large');
    const html = await response.text();
    if (Buffer.byteLength(html, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('MyJobScotland response is too large');
    }
    return { html, url };
  }
  throw new Error('MyJobScotland redirected too many times');
}

export function parseMyJobScotlandPage(rawUrl: string, html: string): DiscoveredJob {
  const url = assertAllowedUrl(rawUrl);
  const posting = jobPostingFromHtml(html);
  const title = text(posting.title);
  const organisation = record(posting.hiringOrganization);
  const employer = text(organisation?.name);
  const descriptionHtml = text(posting.description);
  if (title === null || employer === null || descriptionHtml === null) {
    throw new Error('MyJobScotland job data is missing required fields');
  }
  const canonicalUrl = canonicalizeJobUrl(url.toString());
  const description = plainText(descriptionHtml);
  const employmentType = text(posting.employmentType);
  const employment = Array.isArray(posting.employmentType)
    ? posting.employmentType.filter((item): item is string => typeof item === 'string')
    : employmentType === null
      ? []
      : [employmentType];
  const material = JSON.stringify({
    canonicalUrl,
    posting,
    location: visibleLabel(html, 'Location'),
  });
  return {
    source: 'myjobscotland',
    externalId: externalId(url),
    canonicalUrl,
    title,
    employer,
    location: visibleLabel(html, 'Location') ?? 'Scotland',
    description,
    salary: salary(posting, html),
    employmentTypes: employment,
    contractType: visibleLabel(html, 'Contract Type'),
    hours: visibleLabel(html, 'Hours'),
    workPattern: visibleLabel(html, 'Work From Home'),
    publishedAt: text(posting.datePosted),
    closesAt: text(posting.validThrough),
    contentHash: createHash('sha256').update(material).digest('hex'),
  };
}

export async function fetchMyJobScotlandJob(
  rawUrl: string,
  fetcher: typeof fetch = fetch,
  criteria?: CriteriaReadOptions,
): Promise<DiscoveredJob> {
  const response = await fetchAllowedPage(rawUrl, fetcher);
  const job = parseMyJobScotlandPage(response.url.toString(), response.html);
  if (criteria === undefined) return job;

  const personSpecification = await readPersonSpecification({
    html: response.html,
    pageUrl: response.url.toString(),
    policy: criteria.policy,
    scanner: criteria.scanner,
    fetcher,
    ...(criteria.now === undefined ? {} : { now: criteria.now }),
    ...(criteria.beforeRequest === undefined ? {} : { beforeRequest: criteria.beforeRequest }),
  });
  return { ...job, personSpecification };
}
