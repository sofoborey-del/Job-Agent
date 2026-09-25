export const onboardingPageHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Job Agent Setup</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f5f5f2; color: #17211b; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px 18px 64px; }
    main { max-width: 820px; margin: 0 auto; }
    h1 { margin-bottom: 8px; font-size: clamp(2rem, 7vw, 3.3rem); letter-spacing: -0.05em; }
    h2 { margin: 0 0 8px; font-size: 1.35rem; }
    p { line-height: 1.55; }
    .subtle { color: #526158; font-weight: 450; }
    .card { background: white; border: 1px solid #dce1dc; border-radius: 18px; padding: 24px; margin-top: 20px; box-shadow: 0 8px 32px rgba(23, 33, 27, 0.05); }
    .notice { border-left: 4px solid #d17a22; padding: 12px 16px; background: #fff8ee; border-radius: 8px; }
    .safe { border-left-color: #17663a; background: #effaf3; }
    label { display: block; font-weight: 650; margin: 18px 0 7px; }
    input[type="text"], input[type="email"], input[type="tel"], input[type="password"], input[type="number"], input[type="date"], select, textarea { width: 100%; padding: 12px 14px; border: 1px solid #aeb9b1; border-radius: 10px; font: inherit; background: white; }
    textarea { min-height: 92px; resize: vertical; }
    input:focus, select:focus, textarea:focus { outline: 3px solid #bfe0ca; border-color: #17663a; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
    .checks { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
    .checks label { margin: 0; padding: 10px; border: 1px solid #dce1dc; border-radius: 9px; font-weight: 500; }
    button { margin-top: 20px; border: 0; border-radius: 999px; padding: 13px 22px; font: inherit; font-weight: 700; background: #17663a; color: white; cursor: pointer; }
    button:disabled { opacity: .5; cursor: wait; }
    #status { min-height: 1.5em; margin-top: 14px; font-weight: 650; white-space: pre-line; }
    .success { color: #17663a; }
    .error { color: #a72828; }
    @media (max-width: 620px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main>
  <h1>Build your applicant profile</h1>
  <p class="subtle">Enter only information you know is accurate. You can return and save corrections later; each correction creates a new encrypted version.</p>
  <div class="notice safe"><strong>Local and encrypted:</strong> this form talks only to the service on your computer. It does not sign in to job sites, contact employers, or submit applications.</div>

  <form id="profile-form">
    <section class="card">
      <h2>Secure connection</h2>
      <label for="token">Onboarding access token</label>
      <input id="token" type="password" autocomplete="off" required minlength="32">
      <p class="subtle">Use the private PROFILE_ADMIN_TOKEN from local setup. It stays in this page's memory and is not saved by the browser.</p>
      <label for="profile-id">Existing profile ID <span class="subtle">(leave blank the first time)</span></label>
      <input id="profile-id" type="text" autocomplete="off">
    </section>

    <section class="card">
      <h2>Job preferences</h2>
      <div class="grid">
        <div><label for="salary">Minimum annual base salary (£)</label><input id="salary" type="number" min="25000" step="500" value="25000" required></div>
        <div><label for="roles">Target roles</label><input id="roles" type="text" placeholder="Claims handler, customer service adviser" required></div>
      </div>
      <label for="locations">Acceptable locations</label><input id="locations" type="text" placeholder="Glasgow, UK remote" required>
      <label>Work pattern</label>
      <div class="checks"><label><input name="work-pattern" type="checkbox" value="remote"> Remote</label><label><input name="work-pattern" type="checkbox" value="hybrid"> Hybrid</label><label><input name="work-pattern" type="checkbox" value="onsite"> On-site</label></div>
      <label>Contract type</label>
      <div class="checks"><label><input name="contract-type" type="checkbox" value="permanent" checked> Permanent</label><label><input name="contract-type" type="checkbox" value="fixed_term"> Fixed term</label></div>
      <label>Hours</label>
      <div class="checks"><label><input name="hours" type="checkbox" value="full_time" checked> Full-time</label><label><input name="hours" type="checkbox" value="part_time"> Part-time</label></div>
      <label for="excluded">Excluded roles, sectors or employers <span class="subtle">(optional)</span></label><input id="excluded" type="text" placeholder="Commission-only sales, Example Ltd">
    </section>

    <section class="card">
      <h2>Identity and contact details</h2>
      <p class="subtle">Date of birth and identity documents are deliberately not collected at this stage.</p>
      <div class="grid">
        <div><label for="given-name">Legal first name</label><input id="given-name" type="text" autocomplete="given-name" required></div>
        <div><label for="family-name">Legal surname</label><input id="family-name" type="text" autocomplete="family-name" required></div>
        <div><label for="preferred-name">Preferred name <span class="subtle">(optional)</span></label><input id="preferred-name" type="text"></div>
        <div><label for="email">Application email</label><input id="email" type="email" autocomplete="email" required></div>
        <div><label for="phone">Phone number</label><input id="phone" type="tel" autocomplete="tel" required></div>
        <div><label for="country">Country</label><input id="country" type="text" value="United Kingdom" required></div>
      </div>
      <label for="address-lines">Address line(s)</label><textarea id="address-lines" autocomplete="street-address" required></textarea>
      <div class="grid">
        <div><label for="city">Town or city</label><input id="city" type="text" autocomplete="address-level2" required></div>
        <div><label for="region">Region or council area</label><input id="region" type="text" autocomplete="address-level1" required></div>
        <div><label for="postcode">Postcode</label><input id="postcode" type="text" autocomplete="postal-code" required></div>
      </div>
    </section>

    <section class="card">
      <h2>Work eligibility and availability</h2>
      <div class="grid">
        <div><label for="authorised">Authorised to work in the UK?</label><select id="authorised" required><option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option><option value="unknown">Unsure</option></select></div>
        <div><label for="sponsor-now">Need sponsorship now?</label><select id="sponsor-now" required><option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option><option value="unknown">Unsure</option></select></div>
        <div><label for="sponsor-future">Need sponsorship in future?</label><select id="sponsor-future" required><option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option><option value="unknown">Unsure</option></select></div>
        <div><label for="notice">Notice period</label><input id="notice" type="text" placeholder="4 weeks, immediate" required></div>
        <div><label for="earliest-start">Earliest start date <span class="subtle">(optional)</span></label><input id="earliest-start" type="date"></div>
      </div>
      <label for="restrictions">Work-authorisation restrictions <span class="subtle">(optional)</span></label><textarea id="restrictions"></textarea>
    </section>

    <section class="card">
      <h2>Experience, education and skills</h2>
      <label for="employment">Employment history</label>
      <textarea id="employment" placeholder="One role per line: Employer | Job title | Start YYYY-MM | End YYYY-MM or present | Main responsibilities and achievements"></textarea>
      <p class="subtle">Include every role you want used as evidence. Do not exaggerate responsibilities or achievements.</p>
      <label for="education">Education history</label>
      <textarea id="education" placeholder="One item per line: Institution | Qualification | Field | Start YYYY-MM | End YYYY-MM | Grade (optional)"></textarea>
      <label for="skills">Skills</label><textarea id="skills" placeholder="Comma-separated, for example: customer service, complaint handling, Microsoft Excel"></textarea>
      <label for="qualifications">Certifications and licences <span class="subtle">(optional; one per line)</span></label><textarea id="qualifications" placeholder="Full UK driving licence&#10;Certificate name | Issuer | Expiry YYYY-MM"></textarea>
    </section>

    <section class="card">
      <h2>Current CV</h2>
      <p class="subtle">PDF or DOCX, maximum 5 MB. The file is encrypted immediately and quarantined. It will not be used until a safety scan and your later approval are recorded.</p>
      <p><a href="/cv-review">Already uploaded? Open the CV extraction and review page.</a></p>
      <label for="cv">Choose CV <span class="subtle">(optional for this save)</span></label>
      <input id="cv" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
    </section>

    <section class="card">
      <label class="notice"><input id="confirm" type="checkbox" required> I confirm the information entered is accurate. I understand it may be used for job matching and, after later approval controls are enabled, to fill applications.</label>
      <button id="save" type="submit">Save applicant profile securely</button>
      <p id="status" role="status" aria-live="polite"></p>
    </section>
  </form>
</main>
<script>
(() => {
  'use strict';
  const form = document.getElementById('profile-form');
  const status = document.getElementById('status');
  const saveButton = document.getElementById('save');
  const element = (id) => document.getElementById(id);
  const value = (id) => element(id).value.trim();
  const checked = (name) => [...document.querySelectorAll('input[name="' + name + '"]:checked')].map((input) => input.value);
  const list = (id) => value(id).split(',').map((item) => item.trim()).filter(Boolean);
  const lines = (id) => value(id).split(/\\r?\\n/).map((item) => item.trim()).filter(Boolean);
  const yesNoUnknown = (id) => ({ yes: true, no: false, unknown: 'unknown' })[value(id)];

  const table = (id, minimumColumns, labels) => lines(id).map((line, index) => {
    const columns = line.split('|').map((item) => item.trim());
    if (columns.length < minimumColumns || columns.slice(0, minimumColumns).some((item) => !item)) {
      throw new Error(labels + ' line ' + (index + 1) + ' needs at least ' + minimumColumns + ' parts separated by |.');
    }
    return columns;
  });

  const request = async (path, token, method = 'GET', body) => {
    const response = await fetch(path, {
      method,
      headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401 ? 'The access token was not accepted.' : (payload.message || 'The profile could not be saved.'));
    return payload;
  };

  const fileAsBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The CV could not be read.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.className = '';
    status.textContent = 'Checking and saving…';
    saveButton.disabled = true;
    const token = value('token');
    try {
      const employmentRows = table('employment', 5, 'Employment history');
      const educationRows = table('education', 5, 'Education history');
      let userId = value('profile-id');
      if (!userId) {
        const created = await request('/v1/profile/users', token, 'POST', { timezone: 'Europe/London' });
        userId = created.userId;
        element('profile-id').value = userId;
      }
      const facts = [
        { key: 'preferences.minimum_salary_gbp', value: Number(value('salary')), sensitivity: 'normal', purposes: ['matching', 'application'] },
        { key: 'preferences.target_roles', value: list('roles'), sensitivity: 'normal', purposes: ['matching', 'application'] },
        { key: 'preferences.location', value: list('locations'), sensitivity: 'normal', purposes: ['matching', 'application'] },
        { key: 'preferences.work_pattern', value: checked('work-pattern'), sensitivity: 'normal', purposes: ['matching', 'application'] },
        { key: 'preferences.contract_type', value: checked('contract-type'), sensitivity: 'normal', purposes: ['matching', 'application'] },
        { key: 'preferences.hours', value: checked('hours'), sensitivity: 'normal', purposes: ['matching', 'application'] },
        { key: 'preferences.exclusions', value: list('excluded'), sensitivity: 'normal', purposes: ['matching'] },
        { key: 'identity.legal_name', value: { given: value('given-name'), family: value('family-name'), preferred: value('preferred-name') || null }, sensitivity: 'personal', purposes: ['application'] },
        { key: 'contact.email', value: value('email'), sensitivity: 'personal', purposes: ['application'] },
        { key: 'contact.phone', value: value('phone'), sensitivity: 'personal', purposes: ['application'] },
        { key: 'contact.address', value: { lines: lines('address-lines'), city: value('city'), region: value('region'), postalCode: value('postcode'), country: value('country') }, sensitivity: 'personal', purposes: ['application'] },
        { key: 'work_authorisation.gb', value: { authorised: yesNoUnknown('authorised'), sponsorshipRequiredNow: yesNoUnknown('sponsor-now'), sponsorshipRequiredFuture: yesNoUnknown('sponsor-future'), restrictions: value('restrictions') || null }, sensitivity: 'personal', purposes: ['matching', 'application'] },
        { key: 'eligibility.notice_period', value: value('notice'), sensitivity: 'normal', purposes: ['matching', 'application'] },
      ];
      if (employmentRows.length) facts.push({ key: 'employment.history', value: employmentRows.map((row) => ({ employer: row[0], title: row[1], startDate: row[2], endDate: row[3], evidenceSummary: row.slice(4).join(' | ') })), sensitivity: 'normal', purposes: ['matching', 'application'] });
      if (educationRows.length) facts.push({ key: 'education.history', value: educationRows.map((row) => ({ institution: row[0], qualification: row[1], field: row[2], startDate: row[3], endDate: row[4], grade: row[5] || null })), sensitivity: 'normal', purposes: ['matching', 'application'] });
      if (list('skills').length) facts.push({ key: 'skills.list', value: list('skills'), sensitivity: 'normal', purposes: ['matching', 'application'] });
      if (lines('qualifications').length) facts.push({ key: 'certifications_licences.list', value: lines('qualifications'), sensitivity: 'normal', purposes: ['matching', 'application'] });
      if (value('earliest-start')) facts.push({ key: 'eligibility.earliest_start', value: value('earliest-start'), sensitivity: 'normal', purposes: ['matching', 'application'] });
      for (const fact of facts) {
        await request('/v1/profile/facts', token, 'POST', { userId, key: fact.key, value: fact.value, confirmed: true, sensitivity: fact.sensitivity, usePolicy: 'auto_fill', allowedPurposes: fact.purposes });
      }
      const cv = element('cv').files[0];
      let cvMessage = 'No CV was uploaded.';
      if (cv) {
        if (cv.size > 5 * 1024 * 1024) throw new Error('The CV is larger than 5 MB.');
        const mimeType = cv.type || (cv.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        const uploaded = await request('/v1/profile/documents/cv', token, 'POST', { userId, fileName: cv.name, mimeType, dataBase64: await fileAsBase64(cv), confirmed: true });
        cvMessage = 'CV version ' + uploaded.version + ' is encrypted and quarantined pending safety approval.';
      }
      const readiness = await request('/v1/profile/' + encodeURIComponent(userId) + '/readiness', token);
      status.className = 'success';
      status.textContent = 'Profile saved. Keep this profile ID: ' + userId + '\\n' + cvMessage + '\\n' + readiness.missingCategories.length + ' required categories remain before matching can begin.';
    } catch (error) {
      status.className = 'error';
      status.textContent = error instanceof Error ? error.message : 'Something went wrong.';
    } finally {
      saveButton.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;
