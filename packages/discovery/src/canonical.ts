import { createHash } from 'node:crypto';

const trackingParameters = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source', 'trk']);

function isTrackingParameter(name: string): boolean {
  return name.toLowerCase().startsWith('utm_') || trackingParameters.has(name.toLowerCase());
}

export function canonicalizeJobUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('Only HTTPS job URLs are accepted');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  const retained = [...url.searchParams.entries()]
    .filter(([name]) => !isTrackingParameter(name))
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName
        ? leftValue.localeCompare(rightValue)
        : leftName.localeCompare(rightName),
    );
  url.search = '';
  for (const [name, value] of retained) url.searchParams.append(name, value);
  return url.toString();
}

function canonicalText(value: string): string {
  return value.trim().toLocaleLowerCase('en-GB').replace(/\s+/g, ' ');
}

export type JobIdentityInput = {
  canonicalUrl: string;
  employer: string;
  title: string;
  location: string;
};

export function createJobFingerprint(input: JobIdentityInput): string {
  const canonicalUrl = canonicalizeJobUrl(input.canonicalUrl);
  const material = [
    canonicalUrl,
    canonicalText(input.employer),
    canonicalText(input.title),
    canonicalText(input.location),
  ].join('\u001f');
  return createHash('sha256').update(material).digest('hex');
}

export type SourceJobIdentity = { sourceId: string; externalId: string };

export function createSourceJobKey(identity: SourceJobIdentity): string {
  if (identity.sourceId.trim() === '' || identity.externalId.trim() === '') {
    throw new Error('Source id and external id are required');
  }
  return `${identity.sourceId.trim()}:${identity.externalId.trim()}`;
}

export type DuplicateIdentityInput = {
  employer: string;
  title: string;
  location: string;
  closesAt: string | null;
};

/**
 * Identifies the same vacancy advertised under different URLs. Deliberately excludes the URL so
 * that a second source listing the same role does not create a second canonical job.
 */
export function createDuplicateFingerprint(input: DuplicateIdentityInput): string {
  const material = [
    canonicalText(input.employer),
    canonicalText(input.title),
    canonicalText(input.location),
    input.closesAt ?? '',
  ].join('\u001f');
  return createHash('sha256').update(material).digest('hex');
}
