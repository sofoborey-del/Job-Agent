import { describe, expect, it } from 'vitest';

import { parseMyJobScotlandPage } from './myjobscotland.js';

const fixture = `<!doctype html><html><body>
<script type="application/ld+json">{
  "@context":"https://schema.org",
  "@graph":[{
    "@type":"JobPosting",
    "title":"Customer Services Adviser",
    "datePosted":"2026-09-20T09:00:00Z",
    "validThrough":"2026-10-03T23:59:59Z",
    "employmentType":["FULL_TIME"],
    "baseSalary":{"@type":"MonetaryAmount","currency":"GBP","value":{"@type":"QuantitativeValue","minValue":"28000","maxValue":"31000","unitText":"YEAR"}},
    "hiringOrganization":{"@type":"Organization","name":"Example Council"},
    "description":"<p>Applicants must have customer service experience.</p><p>Training is provided.</p>"
  }]
}</script>
<div>Location:</div><div>Glasgow, G1</div>
<div>Salary:</div><div>£28,000 - £31,000 per year</div>
<div>Contract Type:</div><div>Permanent</div>
<div>Hours:</div><div>35 hours per week</div>
<div>Work From Home:</div><div>Hybrid</div>
</body></html>`;

describe('MyJobScotland public discovery adapter', () => {
  it('normalises structured public job data without accessing candidate pages', () => {
    const job = parseMyJobScotlandPage(
      'https://myjobscotland.gov.uk/councils/example/jobs/customer-services-adviser-489999?utm_source=test',
      fixture,
    );
    expect(job).toMatchObject({
      source: 'myjobscotland',
      externalId: '489999',
      title: 'Customer Services Adviser',
      employer: 'Example Council',
      location: 'Glasgow, G1',
      contractType: 'Permanent',
      hours: '35 hours per week',
      workPattern: 'Hybrid',
      salary: {
        minimumMinor: 2_800_000,
        maximumMinor: 3_100_000,
        currency: 'GBP',
        basis: 'annual_base',
      },
    });
    expect(job.canonicalUrl).not.toContain('utm_source');
    expect(job.description).toContain('must have customer service experience');
    expect(job.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects non-MyJobScotland and non-job URLs', () => {
    expect(() => parseMyJobScotlandPage('https://example.com/jobs/test-1', fixture)).toThrow(
      'Only HTTPS MyJobScotland',
    );
    expect(() => parseMyJobScotlandPage('https://myjobscotland.gov.uk/faqs', fixture)).toThrow(
      'not a MyJobScotland job page',
    );
  });
});
