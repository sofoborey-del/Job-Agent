import { controlsFor, stepTitles, visibleControls, type FormControl } from './form.js';
import type { FakeSession } from './state.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const styles = `
  :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; background:#eef1f6; color:#16202b; }
  * { box-sizing:border-box; }
  body { margin:0; padding:28px 16px; }
  main { width:min(760px,100%); margin:auto; background:#fff; border:1px solid #d3dae5; border-radius:14px; padding:26px; }
  .banner { background:#fff4d6; border:1px solid #e3c濃; border-left:5px solid #c8930f; padding:10px 14px; border-radius:8px; margin-bottom:18px; font-weight:700; }
  h1 { font-size:1.6rem; margin:0 0 4px; }
  .muted { color:#5b6b7c; }
  label { display:block; font-weight:650; margin:16px 0 6px; }
  .hint { font-weight:400; color:#5b6b7c; font-size:.9rem; }
  input[type=text], input[type=email], input[type=tel], input[type=number], textarea, select {
    width:100%; padding:10px 11px; border:1px solid #9fb0c2; border-radius:8px; font:inherit;
  }
  textarea { min-height:110px; }
  fieldset { border:1px solid #d3dae5; border-radius:10px; margin:16px 0; padding:12px 14px; }
  button { margin-top:20px; padding:11px 20px; border:0; border-radius:999px; background:#16202b; color:#fff; font:inherit; font-weight:750; cursor:pointer; }
  button.secondary { background:#e5eaf1; color:#16202b; margin-right:8px; }
  .errors { background:#ffecec; border-left:5px solid #c23b3b; padding:12px 14px; border-radius:8px; }
  .errors ul { margin:6px 0 0; padding-left:20px; }
  dl { display:grid; grid-template-columns:1fr 1fr; gap:6px 16px; }
  dt { font-weight:700; }
`.replace('#e3c濃', '#e3c98f');

function controlHtml(control: FormControl, session: FakeSession): string {
  const value = session.values[control.name] ?? '';
  const id = `f_${control.name}`;
  // A conditional control is validated on the server. It never carries the HTML required
  // attribute, because a hidden required control stops the browser submitting the form at all.
  const required =
    control.required === true && control.conditionalOn === undefined ? ' required' : '';
  const hint =
    control.hint === undefined ? '' : `<span class="hint"> ${escapeHtml(control.hint)}</span>`;
  const labelHtml = `<label for="${id}">${escapeHtml(control.label)}${hint}</label>`;

  if (control.type === 'textarea') {
    const max = control.maxLength === undefined ? '' : ` maxlength="${String(control.maxLength)}"`;
    return `${labelHtml}<textarea id="${id}" name="${control.name}" data-applicant-value${max}${required}>${escapeHtml(value)}</textarea>`;
  }
  if (control.type === 'select') {
    const options = (control.options ?? [])
      .map(
        (option) =>
          `<option value="${escapeHtml(option)}"${option === value ? ' selected' : ''}>${escapeHtml(option)}</option>`,
      )
      .join('');
    return `${labelHtml}<select id="${id}" name="${control.name}" data-applicant-value${required}><option value=""></option>${options}</select>`;
  }
  if (control.type === 'radio') {
    const options = (control.options ?? [])
      .map(
        (option, index) =>
          `<div><input type="radio" id="${id}_${String(index)}" name="${control.name}" value="${escapeHtml(option)}"${option === value ? ' checked' : ''} data-applicant-value><label for="${id}_${String(index)}" style="display:inline;font-weight:400;margin-left:6px">${escapeHtml(option)}</label></div>`,
      )
      .join('');
    return `<fieldset><legend>${escapeHtml(control.label)}</legend>${options}</fieldset>`;
  }
  if (control.type === 'checkbox') {
    return `<div><input type="checkbox" id="${id}" name="${control.name}"${value === 'on' ? ' checked' : ''}${required} data-applicant-value><label for="${id}" style="display:inline;font-weight:400;margin-left:6px">${escapeHtml(control.label)}</label></div>`;
  }
  if (control.type === 'file') {
    return `${labelHtml}<input type="file" id="${id}" name="${control.name}" accept=".pdf,.docx"${required}>`;
  }
  const max = control.maxLength === undefined ? '' : ` maxlength="${String(control.maxLength)}"`;
  return `${labelHtml}<input type="${control.type}" id="${id}" name="${control.name}" value="${escapeHtml(value)}" data-applicant-value${max}${required}>`;
}

function summaryHtml(session: FakeSession): string {
  const rows = Object.entries(session.values)
    .filter(([, value]) => value.trim() !== '')
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join('');
  const cv = session.files.cv;
  const cvRow =
    cv === undefined
      ? ''
      : `<dt>cv</dt><dd>${escapeHtml(cv.filename)} (${String(cv.bytes)} bytes)</dd>`;
  return `<dl>${rows}${cvRow}</dl>`;
}

export function renderStep(input: {
  session: FakeSession;
  stepId: string;
  errors: string[];
  extraReviewField: boolean;
  isLastStep: boolean;
}): string {
  const { session, stepId } = input;
  const controls = visibleControls(stepId, session, input.extraReviewField);
  const hiddenConditional = controlsFor(stepId, session, input.extraReviewField).filter(
    (control) => control.conditionalOn !== undefined && !controls.includes(control),
  );
  const errorBlock =
    input.errors.length === 0
      ? ''
      : `<div class="errors" role="alert"><strong>There is a problem</strong><ul>${input.errors
          .map((error) => `<li>${escapeHtml(error)}</li>`)
          .join('')}</ul></div>`;
  const extraButtons =
    stepId === 'history'
      ? `<button type="submit" class="secondary" name="__action" value="add_employment" id="add-employment" formnovalidate>Add another employer</button>
         <button type="submit" class="secondary" name="__action" value="add_education" id="add-education" formnovalidate>Add another qualification</button>`
      : '';
  const finalButton = input.isLastStep
    ? `<button type="submit" id="submit-application">Submit application</button>`
    : `<button type="submit" id="next">Save and continue</button>`;
  const conditionalScript =
    stepId === 'details'
      ? `<script>
           var radios = document.querySelectorAll('input[name="right_to_work"]');
           var visa = document.getElementById('visa-row');
           function sync() {
             var chosen = document.querySelector('input[name="right_to_work"]:checked');
             if (visa) visa.hidden = !(chosen && chosen.value === 'Sponsorship required');
           }
           radios.forEach(function (radio) { radio.addEventListener('change', sync); });
           sync();
         </script>`
      : '';
  const conditionalHtml = hiddenConditional
    .map((control) => `<div id="visa-row" hidden>${controlHtml(control, session)}</div>`)
    .join('');

  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(stepTitles[stepId] ?? stepId)} — Fake ATS (test software)</title>
  <style>${styles}</style>
</head>
<body data-step="${escapeHtml(stepId)}" data-session="${escapeHtml(session.id)}" data-fake-ats="true">
<main>
  <div class="banner">This is local test software. It is not a real employer and no application is ever sent anywhere.</div>
  <h1>${escapeHtml(stepTitles[stepId] ?? stepId)}</h1>
  <p class="muted">Reference ${escapeHtml(session.jobRef)} · step <span id="step-name">${escapeHtml(stepId)}</span></p>
  ${errorBlock}
  <form method="post" action="/apply/${escapeHtml(session.id)}/${escapeHtml(stepId)}" enctype="multipart/form-data">
    ${stepId === 'review' ? summaryHtml(session) : ''}
    ${controls.map((control) => controlHtml(control, session)).join('')}
    ${conditionalHtml}
    ${extraButtons}
    ${finalButton}
  </form>
  ${conditionalScript}
</main>
</body>
</html>`;
}

export function renderConfirmation(session: FakeSession): string {
  return `<!doctype html>
<html lang="en-GB">
<head><meta charset="utf-8"><title>Application received — Fake ATS (test software)</title><style>${styles}</style></head>
<body data-step="confirmation" data-fake-ats="true">
<main>
  <div class="banner">This is local test software. Nothing was sent to any employer.</div>
  <h1>Application received</h1>
  <p>Your reference is <strong id="confirmation-reference">${escapeHtml(session.reference ?? '')}</strong>.</p>
  <p class="muted">Submitted at ${escapeHtml(session.submittedAt ?? '')}.</p>
</main>
</body>
</html>`;
}

export function renderAmbiguous(): string {
  return `<!doctype html>
<html lang="en-GB">
<head><meta charset="utf-8"><title>Processing — Fake ATS (test software)</title><style>${styles}</style></head>
<body data-step="processing" data-fake-ats="true">
<main>
  <div class="banner">This is local test software.</div>
  <h1>We are processing your application</h1>
  <p>Please do not press submit again. A reference will follow.</p>
</main>
</body>
</html>`;
}

export function renderStart(jobRef: string): string {
  return `<!doctype html>
<html lang="en-GB">
<head><meta charset="utf-8"><title>Start application — Fake ATS (test software)</title><style>${styles}</style></head>
<body data-step="start" data-fake-ats="true">
<main>
  <div class="banner">This is local test software. It is not a real employer.</div>
  <h1>Apply for ${escapeHtml(jobRef)}</h1>
  <form method="post" action="/apply/${escapeHtml(jobRef)}/start">
    <button type="submit" id="start-application">Start application</button>
  </form>
</main>
</body>
</html>`;
}
