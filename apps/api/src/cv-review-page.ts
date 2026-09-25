export const cvReviewPageHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Review CV extraction</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f5f5f2; color: #17211b; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px 18px 64px; }
    main { max-width: 860px; margin: 0 auto; }
    h1 { margin-bottom: 8px; font-size: clamp(2rem, 7vw, 3.3rem); letter-spacing: -0.05em; }
    h2 { margin: 0 0 8px; font-size: 1.3rem; }
    p { line-height: 1.55; }
    .subtle { color: #526158; }
    .card { background: white; border: 1px solid #dce1dc; border-radius: 18px; padding: 24px; margin-top: 20px; box-shadow: 0 8px 32px rgba(23, 33, 27, 0.05); }
    .notice { border-left: 4px solid #d17a22; padding: 12px 16px; background: #fff8ee; border-radius: 8px; }
    label { display: block; font-weight: 650; margin: 18px 0 7px; }
    input[type="text"], input[type="password"], textarea { width: 100%; padding: 12px 14px; border: 1px solid #aeb9b1; border-radius: 10px; font: inherit; }
    textarea { min-height: 150px; resize: vertical; }
    #full-text { min-height: 260px; background: #f8faf8; }
    input:focus, textarea:focus { outline: 3px solid #bfe0ca; border-color: #17663a; }
    button { margin: 18px 8px 0 0; border: 0; border-radius: 999px; padding: 13px 22px; font: inherit; font-weight: 700; background: #17663a; color: white; cursor: pointer; }
    button.secondary { background: #32473a; }
    button:disabled { opacity: .5; cursor: wait; }
    #review { display: none; }
    #status { min-height: 1.5em; margin-top: 14px; font-weight: 650; white-space: pre-line; }
    .success { color: #17663a; }
    .error { color: #a72828; }
  </style>
</head>
<body>
<main>
  <h1>Review your CV extraction</h1>
  <p class="subtle">The CV is processed locally. Review every extracted section and correct it before approval. Empty or unclear sections are never guessed.</p>
  <div class="notice"><strong>Your approval matters:</strong> extraction is only a draft. Selecting approve confirms that the displayed text is truthful and may be used as applicant evidence.</div>

  <section class="card">
    <h2>Open your encrypted CV</h2>
    <label for="token">Onboarding access token</label>
    <input id="token" type="password" autocomplete="off" required minlength="32">
    <label for="profile-id">Profile ID</label>
    <input id="profile-id" type="text" autocomplete="off" required>
    <button id="extract" type="button">Run local safety check and extract</button>
  </section>

  <section id="review" class="card">
    <h2>Extracted draft</h2>
    <p id="document-summary" class="subtle"></p>
    <label for="employment">Employment</label><textarea id="employment"></textarea>
    <label for="education">Education</label><textarea id="education"></textarea>
    <label for="skills">Skills</label><textarea id="skills"></textarea>
    <label for="qualifications">Qualifications and licences</label><textarea id="qualifications"></textarea>
    <label for="full-text">Complete extracted text <span class="subtle">(reference only)</span></label><textarea id="full-text" readonly></textarea>
    <label class="notice"><input id="confirm" type="checkbox"> I have reviewed the extracted text and confirm it is accurate. I authorise this CV version and the reviewed sections for job matching and later application filling under my configured approval rules.</label>
    <button id="approve" type="button">Approve this CV version</button>
  </section>
  <p id="status" role="status" aria-live="polite"></p>
</main>
<script>
(() => {
  'use strict';
  const element = (id) => document.getElementById(id);
  const value = (id) => element(id).value.trim();
  const status = element('status');
  let review = null;
  const suppliedProfileId = new URLSearchParams(window.location.search).get('profileId');
  if (suppliedProfileId && /^[0-9a-f-]{36}$/i.test(suppliedProfileId)) {
    element('profile-id').value = suppliedProfileId;
    window.history.replaceState({}, '', '/cv-review');
  }

  const request = async (path, method, body) => {
    const response = await fetch(path, {
      method,
      headers: { authorization: 'Bearer ' + value('token'), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401 ? 'The access token was not accepted.' : (payload.message || 'The CV operation failed.'));
    return payload;
  };

  element('extract').addEventListener('click', async () => {
    status.className = '';
    status.textContent = 'Checking and extracting locally…';
    element('extract').disabled = true;
    try {
      review = await request('/v1/profile/documents/cv/process', 'POST', { userId: value('profile-id') });
      element('employment').value = review.sections.employment;
      element('education').value = review.sections.education;
      element('skills').value = review.sections.skills;
      element('qualifications').value = review.sections.qualifications;
      element('full-text').value = review.fullText;
      element('document-summary').textContent = 'CV version ' + review.version + ' passed structural safety checks. Review the text below before approval.';
      element('review').style.display = 'block';
      status.className = 'success';
      status.textContent = 'Extraction complete. Nothing has been approved yet.';
    } catch (error) {
      status.className = 'error';
      status.textContent = error instanceof Error ? error.message : 'CV extraction failed.';
    } finally {
      element('extract').disabled = false;
    }
  });

  element('approve').addEventListener('click', async () => {
    if (!review) return;
    if (!element('confirm').checked) {
      status.className = 'error';
      status.textContent = 'Please review the text and tick the confirmation box first.';
      return;
    }
    status.className = '';
    status.textContent = 'Saving your approval…';
    element('approve').disabled = true;
    try {
      const result = await request('/v1/profile/documents/cv/approve', 'POST', {
        userId: value('profile-id'), documentId: review.documentId,
        expectedSha256: review.sha256, confirmed: true,
        reviewedSections: {
          employment: value('employment'), education: value('education'),
          skills: value('skills'), qualifications: value('qualifications'),
        },
      });
      status.className = 'success';
      status.textContent = 'CV approved securely. Matching readiness: ' + (result.readyForMatching ? 'ready' : 'still missing ' + result.missingCategories.join(', ')) + '.';
    } catch (error) {
      status.className = 'error';
      status.textContent = error instanceof Error ? error.message : 'CV approval failed.';
    } finally {
      element('approve').disabled = false;
    }
  });
})();
</script>
</body>
</html>`;
