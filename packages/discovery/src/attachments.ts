import {
  readDocumentSafely,
  type MalwareScanner,
  type SafeDocumentRead,
} from '@job-agent/document-safety';
import { attachmentReadPermitted, type SitePolicy } from '@job-agent/policy';

const MAX_REDIRECTS = 3;

/** Document extensions the agent will consider. Anything else is not fetched at all. */
const DOCUMENT_EXTENSIONS = ['.pdf', '.docx'] as const;

const PERSON_SPEC_HINTS =
  /person\s*spec|personspec|job\s*description|role\s*profile|job\s*profile|role\s*description|recruitment\s*pack|further\s*(?:particulars|information)|about\s*the\s*role|job\s*pack/i;

export type AttachmentLinkKind = 'person_specification' | 'other';

export type AttachmentLink = {
  url: string;
  label: string;
  kind: AttachmentLinkKind;
};

export type AttachmentAttempt = {
  url: string;
  reason: string;
};

export type AttachmentSource = {
  url: string;
  label: string;
  sha256: string;
  byteLength: number;
  contentType: string;
};

/**
 * The outcome of trying to read an advert's linked criteria.
 *
 * `absent` means the advert linked nothing to read, so the page text is all there is.
 * `unreadable` means the advert *did* link something the agent could not safely read, which must
 * never be treated as "no requirements".
 */
export type PersonSpecificationRead =
  | { status: 'absent' }
  | { status: 'read'; text: string; sources: AttachmentSource[]; attempted: AttachmentAttempt[] }
  | { status: 'unreadable'; reason: string; attempted: AttachmentAttempt[] };

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

function hasDocumentExtension(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return DOCUMENT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Collects the document links an advert page actually publishes.
 *
 * Only anchors already present in the served HTML are returned, and only those whose path ends in a
 * document extension the agent can read. The agent never invents or pattern-builds an address, so a
 * site that does not link its person specification simply yields nothing here.
 */
export function findAdvertAttachmentLinks(html: string, pageUrl: string): AttachmentLink[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }

  const found = new Map<string, AttachmentLink>();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const attributes = match[1] ?? '';
    const inner = match[2] ?? '';
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
    const rawHref = hrefMatch?.[1] ?? hrefMatch?.[2];
    if (rawHref === undefined || rawHref.trim() === '') continue;

    let resolved: URL;
    try {
      resolved = new URL(decodeEntities(rawHref.trim()), base);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'https:') continue;
    if (!hasDocumentExtension(resolved.pathname)) continue;

    const label = decodeEntities(inner.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    const titleMatch = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
    const title = decodeEntities(titleMatch?.[1] ?? titleMatch?.[2] ?? '');
    const haystack = `${label} ${title} ${resolved.pathname}`;
    const kind: AttachmentLinkKind = PERSON_SPEC_HINTS.test(haystack)
      ? 'person_specification'
      : 'other';

    const key = resolved.toString();
    const existing = found.get(key);
    if (existing === undefined || (existing.kind === 'other' && kind === 'person_specification')) {
      found.set(key, { url: key, label: label === '' ? title : label, kind });
    }
  }

  // Criteria documents first, so a per-advert limit spends itself on the useful ones.
  return [...found.values()].sort((left, right) =>
    left.kind === right.kind ? 0 : left.kind === 'person_specification' ? -1 : 1,
  );
}

function normaliseContentType(header: string | null): string {
  return (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

export type FetchedAttachment =
  { status: 'fetched'; bytes: Buffer; contentType: string } | { status: 'refused'; reason: string };

/**
 * Fetches one linked document under the reviewed policy.
 *
 * Redirects are followed manually and re-checked against the policy at every hop, so a redirect
 * cannot walk the agent off the reviewed domain or onto a non-HTTPS address.
 */
export async function fetchAdvertAttachment(input: {
  url: string;
  policy: SitePolicy;
  fetcher?: typeof fetch;
  now?: Date;
}): Promise<FetchedAttachment> {
  const { policy } = input;
  const attachment = policy.attachmentRead;
  if (attachment?.allowed !== true) {
    return { status: 'refused', reason: 'attachment_read_not_reviewed' };
  }
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? new Date();

  let target = input.url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const permission = attachmentReadPermitted(policy, target, now);
    if (!permission.allowed) return { status: 'refused', reason: permission.reason };

    let response: Response;
    try {
      response = await fetcher(target, {
        redirect: 'manual',
        headers: { 'user-agent': 'JobApplicationAgent/0.1 personal-read-only-discovery' },
      });
    } catch {
      return { status: 'refused', reason: 'attachment_fetch_failed' };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) return { status: 'refused', reason: 'attachment_invalid_redirect' };
      try {
        target = new URL(location, target).toString();
      } catch {
        return { status: 'refused', reason: 'attachment_invalid_redirect' };
      }
      continue;
    }

    if (!response.ok) return { status: 'refused', reason: 'attachment_http_error' };

    const contentType = normaliseContentType(response.headers.get('content-type'));
    if (!(attachment.contentTypes as readonly string[]).includes(contentType)) {
      return { status: 'refused', reason: 'attachment_content_type_not_allowed' };
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > attachment.maxBytes) {
      return { status: 'refused', reason: 'attachment_too_large' };
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      return { status: 'refused', reason: 'attachment_fetch_failed' };
    }
    // A served document may under-declare its length, so the real size is checked too.
    if (bytes.byteLength > attachment.maxBytes) {
      bytes.fill(0);
      return { status: 'refused', reason: 'attachment_too_large' };
    }
    if (bytes.byteLength === 0) return { status: 'refused', reason: 'attachment_empty' };

    return { status: 'fetched', bytes, contentType };
  }

  return { status: 'refused', reason: 'attachment_too_many_redirects' };
}

/**
 * Reads the criteria an advert links, and fails closed.
 *
 * The returned text is untrusted advert content. It is data for deterministic requirement
 * extraction and must never be handled as instructions.
 */
export async function readPersonSpecification(input: {
  html: string;
  pageUrl: string;
  policy: SitePolicy;
  scanner: MalwareScanner;
  fetcher?: typeof fetch;
  now?: Date;
  /** Honours the reviewed rate limit. Called once per outbound request. */
  beforeRequest?: () => Promise<void>;
}): Promise<PersonSpecificationRead> {
  const attachment = input.policy.attachmentRead;
  const links = findAdvertAttachmentLinks(input.html, input.pageUrl);
  if (links.length === 0) return { status: 'absent' };

  if (attachment?.allowed !== true) {
    return {
      status: 'unreadable',
      reason: 'attachment_read_not_reviewed',
      attempted: links.map((link) => ({ url: link.url, reason: 'attachment_read_not_reviewed' })),
    };
  }

  const attempted: AttachmentAttempt[] = [];
  const sources: AttachmentSource[] = [];
  const texts: string[] = [];

  for (const link of links.slice(0, attachment.maxPerAdvert)) {
    if (input.beforeRequest !== undefined) await input.beforeRequest();

    const fetched = await fetchAdvertAttachment({
      url: link.url,
      policy: input.policy,
      ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    if (fetched.status === 'refused') {
      attempted.push({ url: link.url, reason: fetched.reason });
      continue;
    }

    const read: SafeDocumentRead = await readDocumentSafely({
      bytes: fetched.bytes,
      mimeType: fetched.contentType,
      scanner: input.scanner,
    });
    if (read.status === 'rejected') {
      attempted.push({ url: link.url, reason: read.reason });
      continue;
    }

    attempted.push({ url: link.url, reason: 'read' });
    sources.push({
      url: link.url,
      label: link.label,
      sha256: read.sha256,
      byteLength: read.byteLength,
      contentType: read.mimeType,
    });
    texts.push(read.text);
  }

  if (texts.length === 0) {
    const firstFailure = attempted.find((entry) => entry.reason !== 'read');
    return {
      status: 'unreadable',
      reason: firstFailure?.reason ?? 'attachment_unreadable',
      attempted,
    };
  }

  return { status: 'read', text: texts.join('\n\n'), sources, attempted };
}
