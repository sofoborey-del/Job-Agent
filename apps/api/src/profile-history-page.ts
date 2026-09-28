export const profileHistoryPageHtml = String.raw`<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Complete history from your CV</title>
<style>
  :root{font-family:system-ui,sans-serif;background:#f4f1ea;color:#18322b}*{box-sizing:border-box}
  body{margin:0;padding:30px 16px 70px}main{max-width:900px;margin:auto}h1{font-size:clamp(2rem,5vw,3rem);margin-bottom:8px}
  p{line-height:1.5}.card{background:#fff;border:1px solid #dce4de;border-radius:16px;padding:22px;margin-top:18px}
  .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}label{display:block;font-weight:650;margin-top:12px}
  input,textarea{width:100%;padding:10px;border:1px solid #a9bcb0;border-radius:8px;font:inherit;margin-top:5px}textarea{min-height:94px}
  button{background:#18322b;color:white;border:0;border-radius:999px;padding:11px 18px;font:inherit;font-weight:700;cursor:pointer;margin:14px 8px 0 0}
  button:disabled{opacity:.5}.muted{color:#53665b}.warning{background:#fff4da;border-left:4px solid #ac7723;padding:12px;margin-top:12px}
  .entry{border-top:1px solid #dae3dc;margin-top:18px;padding-top:12px}.status{white-space:pre-line;font-weight:650}a{color:#09604d}
</style></head><body><main>
<p><a href="/tracker">← Back to your jobs</a></p><h1>Complete your profile from your CV</h1>
<p class="muted">This makes the roles and qualifications in your already-approved CV usable for form filling. The draft is not saved until you check it and confirm. No application is sent.</p>
<section class="card"><div class="row"><label>Profile admin token<input id="token" type="password" autocomplete="off"></label>
<label>Profile ID<input id="profile" type="text" autocomplete="off"></label></div>
<button id="load" type="button">Draft from approved CV</button><p id="status" class="status" role="status"></p></section>
<section id="review" class="card" hidden><h2>Check every row</h2><p class="warning">CV employer lines can include a location. Remove it from the employer name if needed. Dates have only month and year; do not invent a day. Check qualifications marked “in progress” or “part-completed.”</p>
<div id="warnings"></div><h2>Employment</h2><div id="employment"></div><button id="add-employment" type="button">Add a missing role</button>
<h2>Education and qualifications</h2><div id="education"></div><button id="add-education" type="button">Add a missing qualification</button>
<label><input id="confirm" type="checkbox" style="width:auto;margin-right:8px">I checked these rows against my CV, corrected them where needed, and authorise their use for job matching and application filling.</label>
<button id="save" type="button">Save verified history</button></section>
</main><script>
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const revision = { value: '' };
  const queryId = new URLSearchParams(location.search).get('profileId');
  if (queryId && /^[0-9a-f-]{36}$/i.test(queryId)) { $('profile').value = queryId; history.replaceState({}, '', '/profile-history'); }
  async function request(path, options) {
    const response = await fetch(path, { ...options, headers: { authorization: 'Bearer ' + $('token').value.trim(), ...(options && options.body ? {'content-type':'application/json'} : {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401 ? 'The admin token was not accepted.' : data.message || 'The request failed.');
    return data;
  }
  function field(container, key, label, value, multiline) {
    const wrap = document.createElement('label'); wrap.textContent = label;
    const control = document.createElement(multiline ? 'textarea' : 'input');
    control.dataset.key = key; control.value = value == null ? '' : String(value);
    wrap.append(control); container.append(wrap);
  }
  function addEntry(kind, item) {
    const entry = document.createElement('div'); entry.className = 'entry'; entry.dataset.kind = kind;
    const heading = document.createElement('strong'); heading.textContent = kind === 'employment' ? 'Role' : 'Qualification'; entry.append(heading);
    if (kind === 'employment') {
      field(entry,'employer','Employer (remove any location suffix)',item.employer);
      field(entry,'title','Job title',item.title);
      field(entry,'startDate','Start month/year',item.startDate);
      field(entry,'endDate','End month/year (blank if current)',item.endDate);
      field(entry,'evidenceSummary','Duties (edit only what you can verify)',item.evidenceSummary,true);
    } else {
      field(entry,'institution','Institution or awarding body',item.institution);
      field(entry,'qualification','Qualification (keep “in progress” or “part-completed” where applicable)',item.qualification);
      field(entry,'field','Subject/field, if stated',item.field);
      field(entry,'startDate','Start month/year, if stated',item.startDate);
      field(entry,'endDate','Completion month/year, if completed',item.endDate);
      field(entry,'grade','Grade, if stated',item.grade);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove this row';
    remove.addEventListener('click', () => entry.remove()); entry.append(remove); $(kind).append(entry);
  }
  function entries(kind) {
    return Array.from($(kind).querySelectorAll('.entry')).map((entry) => {
      const result = {};
      entry.querySelectorAll('[data-key]').forEach((control) => { const value = control.value.trim(); result[control.dataset.key] = value === '' ? null : value; });
      return result;
    });
  }
  $('load').addEventListener('click', async () => {
    $('status').textContent = 'Reading your approved CV history locally…'; $('load').disabled = true; $('review').hidden = true;
    try {
      const id = $('profile').value.trim();
      const draft = await request('/v1/profile/' + encodeURIComponent(id) + '/history-draft');
      revision.value = draft.sourceRevision; $('employment').replaceChildren(); $('education').replaceChildren(); $('warnings').replaceChildren();
      (draft.employment || []).forEach((item) => addEntry('employment', item));
      (draft.education || []).forEach((item) => addEntry('education', item));
      (draft.warnings || []).forEach((warning) => { const p=document.createElement('p'); p.className='warning'; p.textContent=warning; $('warnings').append(p); });
      $('confirm').checked = false; $('review').hidden = false;
      $('status').textContent = 'Drafted ' + draft.employment.length + ' roles and ' + draft.education.length + ' qualifications. Check them before saving.';
    } catch (error) { $('status').textContent = error.message; }
    finally { $('load').disabled = false; }
  });
  $('add-employment').addEventListener('click', () => addEntry('employment', {}));
  $('add-education').addEventListener('click', () => addEntry('education', {}));
  $('save').addEventListener('click', async () => {
    if (!$('confirm').checked) { $('status').textContent = 'Please check the rows and tick the confirmation box.'; return; }
    $('save').disabled = true; $('status').textContent = 'Saving verified history…';
    try {
      const data = await request('/v1/profile/' + encodeURIComponent($('profile').value.trim()) + '/history-confirm', {
        method: 'POST', body: JSON.stringify({ sourceRevision: revision.value, employment: entries('employment'), education: entries('education'), confirmed: true })
      });
      $('status').textContent = 'Saved ' + data.employmentCount + ' roles and ' + data.educationCount + ' qualifications. These can now be used for application preparation.';
    } catch (error) { $('status').textContent = error.message; }
    finally { $('save').disabled = false; }
  });
})();
</script></body></html>`;
