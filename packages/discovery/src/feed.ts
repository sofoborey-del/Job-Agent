import type { SitePolicy } from '@job-agent/policy';
import { assertHostWithinPolicy, hostWithinPolicy } from '@job-agent/policy';

const MAX_FEED_BYTES = 4 * 1024 * 1024;
const MAX_FEED_ITEMS = 500;

export type FeedItem = {
  externalId: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
};

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_match, inner: string) => inner)
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match)
    .trim();
}

function tagText(block: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const match = pattern.exec(block);
  if (match?.[1] === undefined) return null;
  const value = decodeEntities(match[1]);
  return value === '' ? null : value;
}

function atomLink(block: string): string | null {
  const alternate = /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(
    block,
  );
  if (alternate?.[1] !== undefined) return decodeEntities(alternate[1]);
  const plain = /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(block);
  return plain?.[1] === undefined ? null : decodeEntities(plain[1]);
}

function isoOrNull(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Parses a documented RSS 2.0 or Atom feed. Nothing is guessed: entries whose link is outside the
 * reviewed site policy are dropped rather than followed.
 */
export function parseJobFeed(xml: string, policy: SitePolicy): FeedItem[] {
  if (Buffer.byteLength(xml, 'utf8') > MAX_FEED_BYTES)
    throw new Error('Feed response is too large');
  const blocks = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ]
    .map((match) => match[0])
    .slice(0, MAX_FEED_ITEMS);
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const rawLink = tagText(block, 'link') ?? atomLink(block);
    if (rawLink === null) continue;
    if (!hostWithinPolicy(rawLink, policy)) continue;
    const identifier = tagText(block, 'guid') ?? tagText(block, 'id') ?? rawLink;
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    items.push({
      externalId: identifier,
      url: rawLink,
      title: tagText(block, 'title'),
      publishedAt: isoOrNull(
        tagText(block, 'pubDate') ?? tagText(block, 'updated') ?? tagText(block, 'published'),
      ),
    });
  }
  return items;
}

export type FeedFetchOptions = {
  fetcher?: typeof fetch;
  userAgent?: string;
};

export async function fetchJobFeed(
  feedUrl: string,
  policy: SitePolicy,
  options: FeedFetchOptions = {},
): Promise<FeedItem[]> {
  assertHostWithinPolicy(feedUrl, policy);
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(feedUrl, {
    redirect: 'manual',
    headers: {
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8',
      'user-agent': options.userAgent ?? 'JobApplicationAgent/0.1 personal-read-only-discovery',
    },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error('The configured feed redirected; review the feed URL before enabling it');
  }
  if (!response.ok) throw new Error(`Feed returned HTTP ${String(response.status)}`);
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_FEED_BYTES) throw new Error('Feed response is too large');
  const body = await response.text();
  return parseJobFeed(body, policy);
}
