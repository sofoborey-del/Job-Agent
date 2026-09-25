import type { KnowledgeFact } from '@job-agent/domain';
import { sourceDefinitionSchema } from '@job-agent/discovery';
import { DiscoveryService, JobMatchService, type TrackingStores } from '@job-agent/tracking';
import type { MalwareScanner } from '@job-agent/document-safety';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { createTrackingStores } from './stores.js';
import { SqlSitePolicyStore } from './site-policies.js';
import type { PGliteDatabase } from './sql.js';
import { createMigratedTestDatabase } from './testing.js';

const PDF = 'application/pdf';
const advertUrl = 'https://myjobscotland.gov.uk/councils/example/jobs/role-771001';
const specUrl = 'https://myjobscotland.gov.uk/media/person-spec.pdf';

/** A parseable single-page PDF built in the test, so no binary fixture is needed. */
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

/** The page carries a summary only. The criteria live in the linked document, as they really do. */
function pageHtml(): string {
  return `<!doctype html><html><body>
<script type="application/ld+json">{
  "@context":"https://schema.org",
  "@graph":[{
    "@type":"JobPosting",
    "title":"Information Governance Officer",
    "datePosted":"2026-09-20T09:00:00Z",
    "validThrough":"2026-12-03T23:59:59Z",
    "employmentType":["FULL_TIME"],
    "baseSalary":{"@type":"MonetaryAmount","currency":"GBP","value":{"@type":"QuantitativeValue","minValue":"32000","maxValue":"36000","unitText":"YEAR"}},
    "hiringOrganization":{"@type":"Organization","name":"Example Council"},
    "description":"<p>An opportunity has arisen in our team. Please see the attached documents for full details.</p>"
  }]
}</script>
<div>Location:</div><div>Glasgow, G1</div>
<div>Salary:</div><div>£32,000 - £36,000 per year</div>
<div>Contract Type:</div><div>Permanent</div>
<div>Hours:</div><div>35 hours per week</div>
<div>Work From Home:</div><div>Hybrid</div>
<a href="/media/person-spec.pdf">Person Specification</a>
</body></html>`;
}

function fetcherFor(specification: Buffer | 'error'): typeof fetch {
  return ((input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith(advertUrl)) {
      return Promise.resolve(
        new Response(pageHtml(), { status: 200, headers: { 'content-type': 'text/html' } }),
      );
    }
    if (url === specUrl) {
      if (specification === 'error') {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return Promise.resolve(
        new Response(new Uint8Array(specification), {
          status: 200,
          headers: {
            'content-type': PDF,
            'content-length': String(specification.byteLength),
          },
        }),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  }) as unknown as typeof fetch;
}

const cleanScanner: MalwareScanner = { scan: () => Promise.resolve() };

function verifiedFacts(): KnowledgeFact<unknown>[] {
  const make = (key: string, value: unknown): KnowledgeFact<unknown> => ({
    id: uuidv7(),
    key,
    value,
    status: 'verified',
    source: 'user',
    sensitivity: 'normal',
    usePolicy: 'auto_fill',
    allowedPurposes: ['matching', 'application'],
    version: 1,
  });
  return [
    make('preferences.target_roles', ['information governance officer', 'compliance']),
    make('preferences.location', ['Glasgow', 'Hybrid']),
    make('preferences.contract_type', ['permanent']),
    make('skills.governance', 'information governance, data protection, compliance, risk'),
    make(
      'employment.history',
      'Six years in FCA regulated firms covering information governance, compliance and corporate risk.',
    ),
    make('work_authorisation.gb', { authorised: true }),
  ];
}

const firstSpecification =
  'Experience of information governance is essential. A relevant qualification is essential. Membership of the PVG Scheme is essential for this post.';
const revisedSpecification = `${firstSpecification} A full UK driving licence is required for this post.`;

describe('criteria read from a document the advert links', () => {
  let database: { db: PGliteDatabase; close: () => Promise<void> };
  let stores: TrackingStores;
  let userId: string;
  const sourceKey = 'myjobscotland_manual';
  const now = new Date('2026-09-25T09:00:00.000Z');

  const discoveryFor = (specification: Buffer | 'error', withScanner = true): DiscoveryService =>
    new DiscoveryService({
      stores,
      userId,
      sitePolicyFor: (domain) => new SqlSitePolicyStore(database.db).findByDomain(domain),
      fetcher: fetcherFor(specification),
      ...(withScanner ? { scanner: cleanScanner } : {}),
      sleep: () => Promise.resolve(),
    });

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    stores = createTrackingStores(database.db);
    userId = uuidv7();
    await database.db.query(
      `INSERT INTO users (id, timezone, status) VALUES ($1, 'Europe/London', 'active')`,
      [userId],
    );
    await stores.sources.upsertDefinition(
      sourceDefinitionSchema.parse({
        key: sourceKey,
        displayName: 'MyJobScotland saved vacancy links',
        adapterType: 'manual_url_list',
        sitePolicyDomain: 'myjobscotland.gov.uk',
        manualUrls: [advertUrl],
        enabled: true,
        reviewedBy: 'tests',
        reviewedAt: '2026-09-01T00:00:00.000Z',
      }),
      now,
    );
  });

  afterEach(async () => {
    await database.close();
  });

  const addVacancy = async (discovery: DiscoveryService) =>
    discovery.ingestManualUrl({ sourceKey, url: advertUrl, now });

  it('stores the criteria with the job and extracts requirements from them', async () => {
    const added = await addVacancy(discoveryFor(syntheticPdf(firstSpecification)));
    expect(added.status).toBe('ingested');
    expect(added.jobId).not.toBeNull();

    const row = await database.db.query(
      `SELECT person_spec_status, person_spec_text, person_spec_sources_json FROM jobs WHERE id = $1`,
      [added.jobId],
    );
    expect(row.rows[0]?.person_spec_status).toBe('read');
    expect(String(row.rows[0]?.person_spec_text)).toContain('PVG');

    const requirements = await database.db.query(
      `SELECT requirement_text, category FROM job_requirements WHERE job_id = $1`,
      [added.jobId],
    );
    const texts = requirements.rows.map((entry) => String(entry.requirement_text));
    expect(texts.some((text) => /PVG/i.test(text))).toBe(true);
    expect(requirements.rows.some((entry) => entry.category === 'licence')).toBe(true);
  });

  it('records the document that was read, by address and hash, for later audit', async () => {
    const added = await addVacancy(discoveryFor(syntheticPdf(firstSpecification)));
    const row = await database.db.query(`SELECT person_spec_sources_json FROM jobs WHERE id = $1`, [
      added.jobId,
    ]);
    const sources = row.rows[0]?.person_spec_sources_json as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(1);
    expect(sources[0]?.url).toBe(specUrl);
    expect(String(sources[0]?.sha256)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('scores the stored criteria and surfaces what it cannot evidence', async () => {
    const added = await addVacancy(discoveryFor(syntheticPdf(firstSpecification)));
    const matching = new JobMatchService({ stores, userId });
    await matching.matchAwaiting({ facts: verifiedFacts(), now });

    const job = await stores.tracking.getForMatching(userId, added.jobId ?? '');
    expect(job?.job.personSpecification.status).toBe('read');

    const summary = await stores.tracking.list({ userId });
    expect(summary.jobs).toHaveLength(1);
    expect(summary.jobs[0]?.score).toBeGreaterThan(0);
    // The PVG requirement cannot be evidenced, so automatic progression stays blocked.
    const decision = await database.db.query(
      `SELECT explanation_json FROM match_runs WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [added.jobId],
    );
    const explanation = decision.rows[0]?.explanation_json as Record<string, unknown>;
    const blockers = explanation.autoBlockers as string[];
    expect(blockers.some((blocker) => blocker.startsWith('mandatory_unknown:'))).toBe(true);
    expect(blockers).not.toContain('no_mandatory_criteria_visible');
  });

  it('records a new job version when the linked document changes behind an unchanged page', async () => {
    const added = await addVacancy(discoveryFor(syntheticPdf(firstSpecification)));
    const firstVersion = await database.db.query(`SELECT version FROM jobs WHERE id = $1`, [
      added.jobId,
    ]);

    const again = await addVacancy(discoveryFor(syntheticPdf(revisedSpecification)));
    expect(again.jobId).toBe(added.jobId);

    const secondVersion = await database.db.query(
      `SELECT version, person_spec_text FROM jobs WHERE id = $1`,
      [added.jobId],
    );
    expect(Number(secondVersion.rows[0]?.version)).toBeGreaterThan(
      Number(firstVersion.rows[0]?.version),
    );
    expect(String(secondVersion.rows[0]?.person_spec_text)).toContain('driving licence');
  });

  it('stays idempotent when the same advert and document are read again', async () => {
    const added = await addVacancy(discoveryFor(syntheticPdf(firstSpecification)));
    const versionBefore = await database.db.query(`SELECT version FROM jobs WHERE id = $1`, [
      added.jobId,
    ]);
    const again = await addVacancy(discoveryFor(syntheticPdf(firstSpecification)));
    expect(again.jobId).toBe(added.jobId);
    const versionAfter = await database.db.query(`SELECT version FROM jobs WHERE id = $1`, [
      added.jobId,
    ]);
    expect(versionAfter.rows[0]?.version).toEqual(versionBefore.rows[0]?.version);
  });

  it('records unreadable, not absent, when the document cannot be fetched', async () => {
    const added = await addVacancy(discoveryFor('error'));
    const row = await database.db.query(
      `SELECT person_spec_status, person_spec_reason, person_spec_text FROM jobs WHERE id = $1`,
      [added.jobId],
    );
    expect(row.rows[0]?.person_spec_status).toBe('unreadable');
    expect(row.rows[0]?.person_spec_reason).toBe('attachment_http_error');
    expect(row.rows[0]?.person_spec_text).toBeNull();
  });

  it('keeps an unreadable advert visible instead of rejecting it on an incomplete score', async () => {
    const added = await addVacancy(discoveryFor('error'));
    const matching = new JobMatchService({ stores, userId });
    await matching.matchAwaiting({ facts: verifiedFacts(), now });

    const decision = await database.db.query(
      `SELECT explanation_json, action FROM match_runs
        WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [added.jobId],
    );
    const explanation = decision.rows[0]?.explanation_json as Record<string, unknown>;
    expect(explanation.autoBlockers as string[]).toContain('person_specification_unreadable');
    expect(decision.rows[0]?.action).not.toBe('auto_apply');
  });

  it('fetches no document at all when no scanner is available', async () => {
    const added = await addVacancy(discoveryFor(syntheticPdf(firstSpecification), false));
    const row = await database.db.query(`SELECT person_spec_status FROM jobs WHERE id = $1`, [
      added.jobId,
    ]);
    // Without a scanner the agent does not fetch, so there is nothing recorded either way.
    expect(row.rows[0]?.person_spec_status).toBe('absent');
  });
});
