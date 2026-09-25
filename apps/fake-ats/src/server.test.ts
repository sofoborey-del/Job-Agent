import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildFakeAts, type FakeAtsApp } from './server.js';

let app: FakeAtsApp;

function multipart(
  fields: Record<string, string>,
  file?: { name: string; filename: string; content: string },
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----jaaTestBoundary';
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  }
  if (file !== undefined) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: application/pdf\r\n\r\n${file.content}\r\n`,
    );
  }
  parts.push(`--${boundary}--\r\n`);
  return {
    payload: Buffer.from(parts.join(''), 'utf8'),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** Reads the redirect target without a non-null assertion. */
function locationOf(headers: Record<string, unknown>): string {
  const location = headers.location;
  return typeof location === 'string' ? location : '';
}

async function startSession(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/apply/JOB-1/start' });
  const location = locationOf(response.headers);
  return location.split('/')[2] ?? '';
}

const goodDetails = {
  first_name: 'Sam',
  last_name: 'Tester',
  email: 'sam.tester@example.test',
  phone: '07700900000',
  years_experience: '6',
  contract_preference: 'Permanent',
  right_to_work: 'Yes',
  supporting_statement:
    'This is a synthetic supporting statement written only for the local test fixture suite.',
};

beforeEach(() => {
  app = buildFakeAts();
});

afterEach(async () => {
  await app.close();
});

describe('the fake ATS', () => {
  it('says plainly that it is test software and not a real employer', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toMatchObject({ software: 'fake-ats', realEmployer: false });
    const session = await startSession();
    const page = await app.inject({ method: 'GET', url: `/apply/${session}/details` });
    expect(page.body).toContain('This is local test software');
  });

  it('offers every control type the browser framework must handle', async () => {
    const session = await startSession();
    const body = (await app.inject({ method: 'GET', url: `/apply/${session}/details` })).body;
    expect(body).toContain('name="first_name"');
    expect(body).toContain('type="email"');
    expect(body).toContain('type="tel"');
    expect(body).toContain('type="number"');
    expect(body).toContain('<textarea');
    expect(body).toContain('<select');
    expect(body).toContain('type="radio"');
    expect(body).toContain('type="checkbox"');
    expect(body).toContain('favourite_colour');
    const documents = (await app.inject({ method: 'GET', url: `/apply/${session}/documents` }))
      .body;
    expect(documents).toContain('type="file"');
  });

  it('rejects a step with missing required answers and keeps what was typed', async () => {
    const session = await startSession();
    const { payload, headers } = multipart({ first_name: 'Sam' });
    const response = await app.inject({
      method: 'POST',
      url: `/apply/${session}/details`,
      payload,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('There is a problem');
    expect(response.body).toContain('Last name is required.');
    expect(response.body).toContain('value="Sam"');
  });

  it('requires the conditional visa question only when sponsorship is chosen', async () => {
    const session = await startSession();
    const sponsorship = multipart({ ...goodDetails, right_to_work: 'Sponsorship required' });
    const response = await app.inject({
      method: 'POST',
      url: `/apply/${session}/details`,
      payload: sponsorship.payload,
      headers: sponsorship.headers,
    });
    expect(response.body).toContain('Visa type is required.');

    const withVisa = multipart({
      ...goodDetails,
      right_to_work: 'Sponsorship required',
      visa_type: 'Skilled Worker',
    });
    const accepted = await app.inject({
      method: 'POST',
      url: `/apply/${session}/details`,
      payload: withVisa.payload,
      headers: withVisa.headers,
    });
    expect(accepted.statusCode).toBe(303);
  });

  it('adds repeatable employment and education rows on request', async () => {
    const session = await startSession();
    const employment = multipart({ __action: 'add_employment' });
    await app.inject({
      method: 'POST',
      url: `/apply/${session}/history`,
      payload: employment.payload,
      headers: employment.headers,
    });
    const education = multipart({ __action: 'add_education' });
    await app.inject({
      method: 'POST',
      url: `/apply/${session}/history`,
      payload: education.payload,
      headers: education.headers,
    });
    const body = (await app.inject({ method: 'GET', url: `/apply/${session}/history` })).body;
    expect(body).toContain('employment_employer_1');
    expect(body).toContain('education_institution_1');
  });

  it('records an uploaded CV by name and digest without keeping its bytes', async () => {
    const session = await startSession();
    const { payload, headers } = multipart(
      {},
      { name: 'cv', filename: 'synthetic-cv.pdf', content: '%PDF-1.4 synthetic test document' },
    );
    const response = await app.inject({
      method: 'POST',
      url: `/apply/${session}/documents`,
      payload,
      headers,
    });
    expect(response.statusCode).toBe(303);
    const state: { files: Record<string, { filename: string; sha256: string }> } = (
      await app.inject({ method: 'GET', url: `/__state/${session}` })
    ).json();
    expect(state.files.cv?.filename).toBe('synthetic-cv.pdf');
    expect(state.files.cv?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(state)).not.toContain('%PDF');
  });

  it('can be told to fail a step, or to reject the first attempt', async () => {
    await app.inject({
      method: 'POST',
      url: '/__control',
      payload: { failOnStep: 'details', validationOnFirstAttempt: true },
    });
    const session = await startSession();
    const { payload, headers } = multipart(goodDetails);
    const failed = await app.inject({
      method: 'POST',
      url: `/apply/${session}/details`,
      payload,
      headers,
    });
    expect(failed.statusCode).toBe(500);

    await app.inject({ method: 'POST', url: '/__control', payload: { failOnStep: null } });
    const first = await app.inject({
      method: 'POST',
      url: `/apply/${session}/details`,
      payload,
      headers,
    });
    expect(first.body).toContain('The form rejected this attempt');
    const second = await app.inject({
      method: 'POST',
      url: `/apply/${session}/details`,
      payload,
      headers,
    });
    expect(second.statusCode).toBe(303);
  });

  it('issues one reference however many times submit is pressed', async () => {
    const session = await startSession();
    const { payload, headers } = multipart({});
    const first = await app.inject({
      method: 'POST',
      url: `/apply/${session}/review`,
      payload,
      headers,
    });
    expect(first.statusCode).toBe(303);
    const state1: { reference: string; submitCount: number } = (
      await app.inject({ method: 'GET', url: `/__state/${session}` })
    ).json();
    await app.inject({ method: 'POST', url: `/apply/${session}/review`, payload, headers });
    const state2: { reference: string; submitCount: number } = (
      await app.inject({ method: 'GET', url: `/__state/${session}` })
    ).json();
    expect(state2.reference).toBe(state1.reference);
    expect(state2.submitCount).toBe(2);
    const confirmation = await app.inject({ method: 'GET', url: `/apply/${session}/confirmation` });
    expect(confirmation.body).toMatch(/FAKE-ATS-[A-Z0-9]{8}/);
  });

  it('can return an outcome the caller cannot interpret', async () => {
    await app.inject({
      method: 'POST',
      url: '/__control',
      payload: { submitOutcome: 'ambiguous' },
    });
    const session = await startSession();
    const { payload, headers } = multipart({});
    const response = await app.inject({
      method: 'POST',
      url: `/apply/${session}/review`,
      payload,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('We are processing your application');
    expect(response.body).not.toContain('FAKE-ATS-');
  });

  it('can fail the submission outright', async () => {
    await app.inject({ method: 'POST', url: '/__control', payload: { submitOutcome: 'error' } });
    const session = await startSession();
    const { payload, headers } = multipart({});
    const response = await app.inject({
      method: 'POST',
      url: `/apply/${session}/review`,
      payload,
      headers,
    });
    expect(response.statusCode).toBe(502);
    const state: { submitCount: number } = (
      await app.inject({ method: 'GET', url: `/__state/${session}` })
    ).json();
    expect(state.submitCount).toBe(0);
  });

  it('can add a required control to the review page after the fact', async () => {
    await app.inject({
      method: 'POST',
      url: '/__control',
      payload: { requireExtraFieldOnReview: true },
    });
    const session = await startSession();
    const body = (await app.inject({ method: 'GET', url: `/apply/${session}/review` })).body;
    expect(body).toContain('late_addition');
  });
});
