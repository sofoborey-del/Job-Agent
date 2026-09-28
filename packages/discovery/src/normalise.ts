import { createHash } from 'node:crypto';

import { canonicalizeJobUrl, createDuplicateFingerprint } from './canonical.js';
import type { DiscoveredJob } from './myjobscotland.js';

export type NormalisedSalary = DiscoveredJob['salary'];

export type NormalisedJob = {
  descriptionCompleteness?: 'full' | 'snippet';
  sourceKey: string;
  externalId: string;
  canonicalUrl: string;
  fingerprint: string;
  contentHash: string;
  title: string;
  employer: string;
  location: string;
  description: string;
  salary: NormalisedSalary;
  employmentTypes: string[];
  contractType: string | null;
  hours: string | null;
  workPattern: string | null;
  publishedAt: string | null;
  closesAt: string | null;
  personSpecification: NormalisedPersonSpecification;
};

/** The persisted form of an advert's linked criteria, so a match can be reproduced later. */
export type NormalisedPersonSpecification = {
  status: 'absent' | 'read' | 'unreadable';
  text: string | null;
  reason: string | null;
  sources: Array<{ url: string; sha256: string }>;
};

function tidy(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isoOrNull(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Produces the stable shape every downstream step works from. The content hash covers only the
 * normalised fields, so re-fetching an unchanged advert always yields the same hash and the
 * ingestion step stays idempotent.
 */
export function normaliseDiscoveredJob(sourceKey: string, job: DiscoveredJob): NormalisedJob {
  const canonicalUrl = canonicalizeJobUrl(job.canonicalUrl);
  const title = tidy(job.title);
  const employer = tidy(job.employer);
  const location = tidy(job.location);
  const description = job.description.replace(/\r\n/g, '\n').trim();
  const employmentTypes = [...new Set(job.employmentTypes.map(tidy))].sort((left, right) =>
    left.localeCompare(right),
  );
  const contractType = job.contractType === null ? null : tidy(job.contractType);
  const hours = job.hours === null ? null : tidy(job.hours);
  const workPattern = job.workPattern === null ? null : tidy(job.workPattern);
  const publishedAt = isoOrNull(job.publishedAt);
  const closesAt = isoOrNull(job.closesAt);
  const personSpecification = normalisePersonSpecification(job.personSpecification);
  const material = JSON.stringify([
    canonicalUrl,
    title,
    employer,
    location,
    description,
    job.descriptionCompleteness ?? 'full',
    job.salary,
    employmentTypes,
    contractType,
    hours,
    workPattern,
    publishedAt,
    closesAt,
    // Folded in so that a changed criteria document bumps the job version and forces a re-match,
    // instead of an updated person specification passing unnoticed behind an unchanged page.
    personSpecification.status,
    personSpecification.reason,
    personSpecification.sources.map((source) => source.sha256),
  ]);
  return {
    sourceKey,
    externalId: job.externalId,
    canonicalUrl,
    fingerprint: createDuplicateFingerprint({ employer, title, location, closesAt }),
    contentHash: createHash('sha256').update(material).digest('hex'),
    title,
    employer,
    location,
    description,
    descriptionCompleteness: job.descriptionCompleteness ?? 'full',
    salary: job.salary,
    employmentTypes,
    contractType,
    hours,
    workPattern,
    publishedAt,
    closesAt,
    personSpecification,
  };
}

function normalisePersonSpecification(
  read: DiscoveredJob['personSpecification'],
): NormalisedPersonSpecification {
  if (read === undefined || read.status === 'absent') {
    return { status: 'absent', text: null, reason: null, sources: [] };
  }
  if (read.status === 'unreadable') {
    return { status: 'unreadable', text: null, reason: read.reason, sources: [] };
  }
  return {
    status: 'read',
    text: read.text,
    reason: null,
    sources: read.sources
      .map((source) => ({ url: source.url, sha256: source.sha256 }))
      .sort((left, right) => left.sha256.localeCompare(right.sha256)),
  };
}
