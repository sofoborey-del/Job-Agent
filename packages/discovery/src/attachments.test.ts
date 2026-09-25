import { DOCX_MIME, ThreatDetectedError, type MalwareScanner } from '@job-agent/document-safety';
import { sitePolicySchema, type SitePolicy } from '@job-agent/policy';
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

import {
  fetchAdvertAttachment,
  findAdvertAttachmentLinks,
  readPersonSpecification,
} from './attachments.js';

const PDF = 'application/pdf';
const DOCX = DOCX_MIME;
const pageUrl = 'https://myjobscotland.gov.uk/jobs/information-governance-adviser-12345';
const now = new Date('2026-06-01T00:00:00.000Z');

const policy: SitePolicy = sitePolicySchema.parse({
  domain: 'myjobscotland.gov.uk',
  discoveryMode: 'manual_url',
  applyMode: 'prefill_only',
  termsStatus: 'permission_required',
  evidenceUrl: 'https://myjobscotland.gov.uk/disclaimer',
  reviewedAt: '2026-01-01T00:00:00.000Z',
  reviewExpiresAt: '2027-01-01T00:00:00.000Z',
  autoSubmitAllowed: false,
  rateLimit: { requests: 10, windowSeconds: 60 },
  attachmentRead: {
    allowed: true,
    contentTypes: [PDF],
    maxBytes: 1_048_576,
    maxPerAdvert: 3,
  },
  version: 2,
});

const policyWithoutPermission: SitePolicy = sitePolicySchema.parse({
  ...policy,
  attachmentRead: undefined,
  version: 1,
});

const cleanScanner: MalwareScanner = { scan: () => Promise.resolve() };
const threatScanner: MalwareScanner = {
  scan: () => Promise.reject(new ThreatDetectedError()),
};
const brokenScanner: MalwareScanner = {
  scan: () => Promise.reject(new Error('Microsoft Defender could not complete the scan')),
};

type RequestHandler = (url: string) => Response;

/** The single place this file asserts a fetch-shaped stub, so no test needs its own cast. */
function stubFetch(handler: RequestHandler): typeof fetch {
  return ((input: string | URL) =>
    Promise.resolve(
      handler(typeof input === 'string' ? input : input.toString()),
    )) as unknown as typeof fetch;
}

/**
 * A minimal but genuinely parseable single-page PDF, built here so the test needs no binary
 * fixture. The text is invented criteria for a role that does not exist.
 */
function syntheticPdf(bodyText: string): Buffer {
  // One text-showing operator per sentence, so a long specification is not clipped.
  const shown = bodyText
    .split(/(?<=\.)\s+/)
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      const escaped = line.replace(/([()\\])/g, '\\$1');
      return `BT /F1 11 Tf 40 ${String(740 - index * 18)} Td (${escaped}) Tj ET`;
    })
    .join('\n');
  const stream = `${shown}\n`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${String(Buffer.byteLength(stream, 'latin1'))} >>\nstream\n${stream}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const criteriaText =
  'Membership of the PVG Scheme is essential for this post. A full UK driving licence is required. Experience of records management is essential. Knowledge of data protection legislation is essential.';

function pdfResponse(bytes: Buffer, contentType = PDF): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength) },
  });
}

function advertHtml(links: string): string {
  return `<html><body><h1>Information Governance Adviser</h1>${links}</body></html>`;
}

describe('finding the documents an advert publishes', () => {
  it('finds a linked person specification and marks it as one', () => {
    const links = findAdvertAttachmentLinks(
      advertHtml(
        '<a href="/media/person-spec.pdf">Person Specification</a><a href="/media/pay.pdf">Pay scales</a>',
      ),
      pageUrl,
    );
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      url: 'https://myjobscotland.gov.uk/media/person-spec.pdf',
      kind: 'person_specification',
    });
    // Criteria documents sort first so a per-advert limit is spent on the useful ones.
    expect(links[1]?.kind).toBe('other');
  });

  it('recognises a job description and a recruitment pack', () => {
    const links = findAdvertAttachmentLinks(
      advertHtml(
        '<a href="/d/jd.pdf">Job Description</a><a href="/d/pack.docx">Recruitment Pack</a>',
      ),
      pageUrl,
    );
    expect(links.map((link) => link.kind)).toEqual([
      'person_specification',
      'person_specification',
    ]);
  });

  it('ignores a link that is not a readable document', () => {
    const links = findAdvertAttachmentLinks(
      advertHtml(
        '<a href="/jobs/another-1">Another vacancy</a><a href="/media/video.mp4">Video</a><a href="/media/image.png">Photo</a>',
      ),
      pageUrl,
    );
    expect(links).toEqual([]);
  });

  it('ignores a document on another host, and never invents an address', () => {
    const links = findAdvertAttachmentLinks(
      advertHtml('<a href="https://example.com/spec.pdf">Person Specification</a>'),
      pageUrl,
    );
    expect(links.map((link) => link.url)).toEqual(['https://example.com/spec.pdf']);
    // Discovery lists it, but the policy gate is what refuses it. Proven below.
  });

  it('returns nothing when the advert links no document at all', () => {
    expect(findAdvertAttachmentLinks(advertHtml('<p>Apply online.</p>'), pageUrl)).toEqual([]);
  });
});

describe('fetching a linked document safely', () => {
  it('refuses a document on a host outside the reviewed policy', async () => {
    const fetcher = vi.fn<RequestHandler>();
    const result = await fetchAdvertAttachment({
      url: 'https://example.com/spec.pdf',
      policy,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result).toEqual({ status: 'refused', reason: 'attachment_host_outside_policy' });
    // Nothing was requested at all.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses a redirect that leaves the reviewed domain', async () => {
    const fetcher = vi.fn<RequestHandler>(
      () =>
        new Response(null, { status: 302, headers: { location: 'https://example.com/spec.pdf' } }),
    );
    const result = await fetchAdvertAttachment({
      url: 'https://myjobscotland.gov.uk/media/spec.pdf',
      policy,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result).toEqual({ status: 'refused', reason: 'attachment_host_outside_policy' });
  });

  it('refuses a redirect that downgrades to plain HTTP', async () => {
    const fetcher = vi.fn<RequestHandler>(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://myjobscotland.gov.uk/media/spec.pdf' },
        }),
    );
    const result = await fetchAdvertAttachment({
      url: 'https://myjobscotland.gov.uk/media/spec.pdf',
      policy,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result).toEqual({ status: 'refused', reason: 'attachment_not_https' });
  });

  it('follows a redirect that stays on the reviewed domain', async () => {
    const bytes = syntheticPdf(criteriaText);
    let call = 0;
    const fetcher = vi.fn<RequestHandler>(() => {
      call += 1;
      return call === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://myjobscotland.gov.uk/media/moved.pdf' },
          })
        : pdfResponse(bytes);
    });
    const result = await fetchAdvertAttachment({
      url: 'https://myjobscotland.gov.uk/media/spec.pdf',
      policy,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result.status).toBe('fetched');
  });

  it('gives up rather than following a redirect loop forever', async () => {
    const fetcher = vi.fn<RequestHandler>(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://myjobscotland.gov.uk/media/loop.pdf' },
        }),
    );
    const result = await fetchAdvertAttachment({
      url: 'https://myjobscotland.gov.uk/media/loop.pdf',
      policy,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result).toEqual({ status: 'refused', reason: 'attachment_too_many_redirects' });
  });

  it('refuses a content type the reviewed policy does not list', async () => {
    const fetcher = vi.fn<RequestHandler>(() =>
      pdfResponse(syntheticPdf(criteriaText), 'text/html'),
    );
    const result = await fetchAdvertAttachment({
      url: 'https://myjobscotland.gov.uk/media/spec.pdf',
      policy,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result).toEqual({ status: 'refused', reason: 'attachment_content_type_not_allowed' });
  });

  it('refuses a document that declares itself too large', async () => {
    const fetcher = vi.fn<RequestHandler>(
      () =>
        new Response(new Uint8Array(Buffer.from('%PDF-1.4 small')), {
          status: 200,
          headers: { 'content-type': PDF, 'content-length': '99999999' },
        }),
    );
    const result = await fetchAdvertAttachment({
      url: 'https://myjobscotland.gov.uk/media/spec.pdf',
      policy,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result).toEqual({ status: 'refused', reason: 'attachment_too_large' });
  });

  it('refuses a document that under-declares its length and is actually too large', async () => {
    const oversized = Buffer.concat([
      Buffer.from('%PDF-1.4 '),
      Buffer.alloc((policy.attachmentRead?.maxBytes ?? 0) + 1, 0x20),
    ]);
    const fetcher = vi.fn<RequestHandler>(
      () =>
        new Response(new Uint8Array(oversized), {
          status: 200,
          headers: { 'content-type': PDF, 'content-length': '10' },
        }),
    );
    const result = await fetchAdvertAttachment({
      url: 'https://myjobscotland.gov.uk/media/spec.pdf',
      policy,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result).toEqual({ status: 'refused', reason: 'attachment_too_large' });
  });

  it('refuses an HTTP error', async () => {
    const fetcher = vi.fn<RequestHandler>(() => new Response(null, { status: 404 }));
    const result = await fetchAdvertAttachment({
      url: 'https://myjobscotland.gov.uk/media/spec.pdf',
      policy,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result).toEqual({ status: 'refused', reason: 'attachment_http_error' });
  });
});

describe('reading an advert’s criteria, and failing closed', () => {
  const html = advertHtml('<a href="/media/person-spec.pdf">Person Specification</a>');

  it('reads the criteria and reports where they came from', async () => {
    const bytes = syntheticPdf(criteriaText);
    const fetcher = vi.fn<RequestHandler>(() => pdfResponse(bytes));
    const result = await readPersonSpecification({
      html,
      pageUrl,
      policy,
      scanner: cleanScanner,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.text).toContain('PVG');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sources[0]?.url).toBe('https://myjobscotland.gov.uk/media/person-spec.pdf');
  });

  it('reports absent, not unreadable, when the advert links nothing', async () => {
    const fetcher = vi.fn<RequestHandler>();
    const result = await readPersonSpecification({
      html: advertHtml('<p>Apply online.</p>'),
      pageUrl,
      policy,
      scanner: cleanScanner,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result).toEqual({ status: 'absent' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is unreadable, never absent, when a linked document is refused by policy', async () => {
    const fetcher = vi.fn<RequestHandler>();
    const result = await readPersonSpecification({
      html,
      pageUrl,
      policy: policyWithoutPermission,
      scanner: cleanScanner,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result.status).toBe('unreadable');
    if (result.status !== 'unreadable') return;
    expect(result.reason).toBe('attachment_read_not_reviewed');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is unreadable when the scanner reports a threat, and keeps no text', async () => {
    const fetcher = vi.fn<RequestHandler>(() => pdfResponse(syntheticPdf(criteriaText)));
    const result = await readPersonSpecification({
      html,
      pageUrl,
      policy,
      scanner: threatScanner,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result.status).toBe('unreadable');
    if (result.status !== 'unreadable') return;
    expect(result.reason).toBe('malware_detected');
  });

  it('is unreadable when the scanner cannot run, rather than skipping the scan', async () => {
    const fetcher = vi.fn<RequestHandler>(() => pdfResponse(syntheticPdf(criteriaText)));
    const result = await readPersonSpecification({
      html,
      pageUrl,
      policy,
      scanner: brokenScanner,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result.status).toBe('unreadable');
    if (result.status !== 'unreadable') return;
    expect(result.reason).toBe('scan_unavailable');
  });

  it('refuses a PDF carrying active content before the scanner or parser sees it', async () => {
    const withJavaScript = Buffer.concat([
      syntheticPdf(criteriaText),
      Buffer.from('\n<< /JavaScript (app.alert) >>\n', 'latin1'),
    ]);
    const scan = vi.fn(() => Promise.resolve());
    const result = await readPersonSpecification({
      html,
      pageUrl,
      policy,
      scanner: { scan },
      fetcher: stubFetch(() => pdfResponse(withJavaScript)),
      now,
    });
    expect(result.status).toBe('unreadable');
    if (result.status !== 'unreadable') return;
    expect(result.reason).toBe('active_content');
    expect(scan).not.toHaveBeenCalled();
  });

  it('refuses bytes that do not match the declared content type', async () => {
    const notAPdf = Buffer.from('<html>definitely not a pdf</html>');
    const result = await readPersonSpecification({
      html,
      pageUrl,
      policy,
      scanner: cleanScanner,
      fetcher: stubFetch(() => pdfResponse(notAPdf)),
      now,
    });
    expect(result.status).toBe('unreadable');
    if (result.status !== 'unreadable') return;
    expect(result.reason).toBe('signature_mismatch');
  });

  it('honours the reviewed rate limit before each request', async () => {
    const beforeRequest = vi.fn(() => Promise.resolve());
    await readPersonSpecification({
      html: advertHtml(
        '<a href="/d/spec.pdf">Person Specification</a><a href="/d/jd.pdf">Job Description</a>',
      ),
      pageUrl,
      policy,
      scanner: cleanScanner,
      fetcher: stubFetch(() => pdfResponse(syntheticPdf(criteriaText))),
      now,
      beforeRequest,
    });
    expect(beforeRequest).toHaveBeenCalledTimes(2);
  });

  it('never fetches more documents than the reviewed policy allows per advert', async () => {
    const fetcher = vi.fn<RequestHandler>(() => pdfResponse(syntheticPdf(criteriaText)));
    const manyLinks = Array.from(
      { length: 8 },
      (_value, index) => `<a href="/d/spec-${String(index)}.pdf">Person Specification</a>`,
    ).join('');
    await readPersonSpecification({
      html: advertHtml(manyLinks),
      pageUrl,
      policy,
      scanner: cleanScanner,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(fetcher).toHaveBeenCalledTimes(policy.attachmentRead?.maxPerAdvert ?? 0);
  });

  it('reads the documents it can when one of several fails', async () => {
    let call = 0;
    const fetcher = vi.fn<RequestHandler>(() => {
      call += 1;
      return call === 1
        ? new Response(null, { status: 500 })
        : pdfResponse(syntheticPdf(criteriaText));
    });
    const result = await readPersonSpecification({
      html: advertHtml(
        '<a href="/d/spec.pdf">Person Specification</a><a href="/d/jd.pdf">Job Description</a>',
      ),
      pageUrl,
      policy,
      scanner: cleanScanner,
      fetcher: stubFetch(fetcher),
      now,
    });
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.sources).toHaveLength(1);
    expect(result.attempted.map((entry) => entry.reason)).toEqual([
      'attachment_http_error',
      'read',
    ]);
  });

  it('treats a DOCX whose relationships reach outside the document as unreadable', async () => {
    const docx = new JSZip();
    docx.file(
      'word/_rels/document.xml.rels',
      '<?xml version="1.0"?><Relationships><Relationship TargetMode="External" Target="https://example.com/x"/></Relationships>',
    );
    docx.file('word/document.xml', '<?xml version="1.0"?><document/>');
    const bytes = await docx.generateAsync({ type: 'nodebuffer' });

    const docxPolicy = sitePolicySchema.parse({
      ...policy,
      attachmentRead: { ...policy.attachmentRead, contentTypes: [DOCX] },
    });
    const result = await readPersonSpecification({
      html: advertHtml('<a href="/media/person-spec.docx">Person Specification</a>'),
      pageUrl,
      policy: docxPolicy,
      scanner: cleanScanner,
      fetcher: stubFetch(
        () =>
          new Response(new Uint8Array(bytes), {
            status: 200,
            headers: { 'content-type': DOCX, 'content-length': String(bytes.byteLength) },
          }),
      ),
      now,
    });
    expect(result.status).toBe('unreadable');
    if (result.status !== 'unreadable') return;
    expect(result.reason).toBe('active_content');
  });
});
