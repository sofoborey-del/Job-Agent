export const applicationPrepPageHtml = String.raw`<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prepare one application</title><style>
:root{font-family:system-ui,sans-serif;background:#f4f1ea;color:#18322b}*{box-sizing:border-box}body{margin:0;padding:30px 16px 70px}
main{max-width:940px;margin:auto}h1{font-size:clamp(1.9rem,5vw,2.8rem);margin-bottom:8px}h2{margin:0 0 4px}p{line-height:1.5}
.card{background:#fff;border:1px solid #dce4de;border-radius:16px;padding:22px;margin-top:18px}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
label{display:block;font-weight:650;margin-top:12px}input,select,textarea{width:100%;padding:10px;border:1px solid #a9bcb0;border-radius:8px;font:inherit;margin-top:5px}
button{background:#18322b;color:white;border:0;border-radius:999px;padding:11px 18px;font:inherit;font-weight:700;cursor:pointer;margin:14px 8px 0 0}
button.small{padding:6px 12px;font-size:.85rem;margin:0}button:disabled{opacity:.5}
.muted{color:#53665b}.notice{background:#fff4da;border-left:4px solid #ac7723;padding:12px;margin-top:12px}
.stop{background:#fdeaea;border-left:4px solid #9c2b2b;padding:12px;margin-top:12px}
.q{border-top:1px solid #e3eae4;padding:12px 0;display:grid;grid-template-columns:1fr auto;gap:10px;align-items:start}
.q:first-of-type{border-top:0}.q .val{white-space:pre-wrap;font-weight:650;margin:4px 0}
.tag{display:inline-block;font-size:.72rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;border-radius:999px;padding:3px 9px;margin-right:6px}
.tag.ready{background:#dcf0e4;color:#14562f}.tag.you{background:#fde9cf;color:#8a4b09}.tag.human{background:#e6e6f2;color:#3b3b6b}
.src{font-size:.82rem;color:#53665b}.count{font-weight:700}
fieldset{border:1px solid #cfd9d2;border-radius:10px;margin-top:12px}legend{font-weight:700;padding:0 6px}
fieldset label{font-weight:400;margin-top:4px}fieldset input{width:auto;margin-right:8px}
a{color:#09604d}code{background:#eef2ee;padding:1px 5px;border-radius:5px}
</style></head><body><main>
<p><a href="/tracker">← Back to your jobs</a></p>
<h1>Prepare one application</h1>
<p class="muted">This screen reads your approved profile and shows the answers it can evidence, so you can copy them into the employer’s own form. It does not open the employer site, fill anything in, or send anything. Nothing here is an application.</p>
<p class="notice">The agent cannot fill a real employer form. Assisted filling stays switched off until a written permission review allows it, and final submission is always yours. See <code>docs/real-application-pilot.md</code>.</p>

<section class="card"><h2>Which job</h2>
<div class="row">
<label>Profile admin token<input id="token" type="password" autocomplete="off"></label>
<label>Profile ID<input id="profile" type="text" autocomplete="off"></label>
<label>Job ID<input id="job" type="text" autocomplete="off"></label>
</div>
<fieldset><legend>Optional: also show my saved reusable answers</legend>
<p class="muted">Off by default. Equality-monitoring answers are entirely optional, are never filled in for you, and are shown only for the topics you tick here, on this screen, for this job.</p>
<div id="topics"></div></fieldset>
<button id="load" type="button">Show my answers for this job</button>
<p id="status" role="status"></p></section>

<div id="out"></div>
</main><script>
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const topics = [
    ['ethnicity','Ethnicity'],['gender_identity','Gender identity'],['sexual_orientation','Sexual orientation'],
    ['disability_status','Disability status'],['religion','Religion or belief'],['marital_status','Marital status'],
    ['customer_service_example','Customer-service example'],['handling_sensitive_information_example','Handling-sensitive-information example']
  ];
  topics.forEach(([value, label]) => {
    const wrap = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox'; box.value = value; box.className = 'topic';
    wrap.append(box, document.createTextNode(label));
    $('topics').append(wrap);
  });

  const params = new URLSearchParams(location.search);
  const uuid = /^[0-9a-f-]{36}$/i;
  if (uuid.test(params.get('profileId') || '')) $('profile').value = params.get('profileId');
  if (uuid.test(params.get('jobId') || '')) $('job').value = params.get('jobId');
  if (params.toString()) history.replaceState({}, '', '/application-prep');

  async function post(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + $('token').value.trim(), 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 401 ? 'The admin token was not accepted.' : (data.message || data.error || 'The request failed.'));
      error.payload = data;
      throw error;
    }
    return data;
  }

  function copyButton(text, label) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'small'; button.textContent = label || 'Copy';
    button.addEventListener('click', () => {
      const done = () => { button.textContent = 'Copied'; setTimeout(() => { button.textContent = label || 'Copy'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => { button.textContent = 'Select it manually'; });
      } else { button.textContent = 'Select it manually'; }
    });
    return button;
  }

  function renderItem(entry) {
    const row = document.createElement('div'); row.className = 'q';
    const left = document.createElement('div');
    const head = document.createElement('div');
    const tag = document.createElement('span');
    tag.className = 'tag ' + (entry.status === 'ready' ? 'ready' : entry.status === 'needs_you' ? 'you' : 'human');
    tag.textContent = entry.status === 'ready' ? 'Ready to copy' : entry.status === 'needs_you' ? 'You answer this' : 'Yours only';
    head.append(tag);
    const title = document.createElement('strong');
    title.textContent = (entry.rowLabel ? entry.rowLabel + ' — ' : '') + entry.label + (entry.required ? ' *' : '');
    head.append(title);
    left.append(head);
    if (entry.value !== null && entry.value !== undefined) {
      const value = document.createElement('div'); value.className = 'val'; value.textContent = entry.value;
      left.append(value);
    }
    const note = document.createElement('div'); note.className = 'src'; note.textContent = entry.note;
    const source = document.createElement('div'); source.className = 'src'; source.textContent = 'Source: ' + entry.source.label;
    left.append(note, source);
    row.append(left);
    if (entry.status === 'ready' && entry.value) row.append(copyButton(entry.value));
    return row;
  }

  function render(data) {
    const out = $('out'); out.replaceChildren();
    const pack = data.pack;

    const head = document.createElement('section'); head.className = 'card';
    const heading = document.createElement('h2');
    heading.textContent = data.jobTitle + (data.employer ? ' — ' + data.employer : '');
    const state = document.createElement('p');
    state.textContent = data.message;
    const counts = document.createElement('p');
    counts.textContent = pack.summary.ready + ' ready to copy · ' + pack.summary.needsYou + ' need you ('
      + pack.summary.requiredNeedsYou + ' of them required) · ' + pack.summary.humanOnly + ' are yours alone.';
    counts.className = 'count';
    head.append(heading, state, counts);
    if (!data.reviewedForThisSite) {
      const general = document.createElement('p'); general.className = 'notice';
      general.textContent = 'This is a general application outline, not a reviewed description of this employer’s form. Read the real form: a box shown here may be absent, and a box on the form may be missing here.';
      head.append(general);
    }
    const form = document.createElement('p'); form.className = 'muted';
    form.textContent = 'Outline: ' + pack.form.providerName + ' (' + pack.form.id + ' ' + pack.form.version + '). Assisted filling: off. Automatic submission: off.';
    head.append(form);
    (pack.warnings || []).forEach((warning) => {
      const line = document.createElement('p'); line.className = 'notice'; line.textContent = warning; head.append(line);
    });
    if (pack.cvAttachment) {
      const cv = document.createElement('p'); cv.className = 'muted';
      cv.textContent = 'Attach your approved CV yourself: ' + pack.cvAttachment.filename + ' (SHA-256 ' + pack.cvAttachment.sha256.slice(0, 12) + '…).';
      head.append(cv);
    }
    if (pack.clipboardText) {
      head.append(copyButton(pack.clipboardText, 'Copy every ready answer'));
      const caveat = document.createElement('p'); caveat.className = 'muted';
      caveat.textContent = 'Copy-all never includes a reusable answer, an equality-monitoring answer or a declaration.';
      head.append(caveat);
    }
    out.append(head);

    (pack.sections || []).forEach((section) => {
      if (!section.items.length) return;
      const card = document.createElement('section'); card.className = 'card';
      const title = document.createElement('h2'); title.textContent = section.title;
      card.append(title);
      if (section.humanOnly) {
        const only = document.createElement('p'); only.className = 'stop';
        only.textContent = 'This whole step is yours. The agent shows no answer for any question on it.';
        card.append(only);
      }
      section.items.forEach((entry) => card.append(renderItem(entry)));
      out.append(card);
    });

    if ((pack.reusableAnswers || []).length) {
      const card = document.createElement('section'); card.className = 'card';
      const title = document.createElement('h2'); title.textContent = 'Your reusable answers, because you asked for them';
      card.append(title);
      pack.reusableAnswers.forEach((entry) => {
        const row = document.createElement('div'); row.className = 'q';
        const left = document.createElement('div');
        const name = document.createElement('strong'); name.textContent = entry.label + (entry.sensitive ? ' (private)' : '');
        const value = document.createElement('div'); value.className = 'val'; value.textContent = entry.answer;
        const note = document.createElement('div'); note.className = 'src'; note.textContent = entry.note;
        left.append(name, value, note); row.append(left, copyButton(entry.answer));
        card.append(row);
      });
      out.append(card);
    }

    const footer = document.createElement('section'); footer.className = 'card';
    const done = document.createElement('p');
    done.textContent = 'When you have submitted the form on the employer’s site, go back to your jobs and record it as submitted, so this vacancy is never offered again.';
    const link = document.createElement('a'); link.href = '/tracker'; link.textContent = 'Back to your jobs';
    footer.append(done, link);
    out.append(footer);
  }

  $('load').addEventListener('click', async () => {
    $('load').disabled = true;
    $('status').textContent = 'Reading your approved profile…';
    $('out').replaceChildren();
    const chosen = [...document.querySelectorAll('.topic')].filter((box) => box.checked).map((box) => box.value);
    try {
      const data = await post(
        '/v1/applications/' + encodeURIComponent($('profile').value.trim())
          + '/preparation/' + encodeURIComponent($('job').value.trim()) + '/answer-pack',
        { includeReusableAnswers: chosen }
      );
      render(data);
      $('status').textContent = 'Nothing was sent to an employer. Copy what you need.';
    } catch (error) {
      $('status').textContent = error.message;
      const blocked = error.payload && error.payload.preparation;
      if (blocked) {
        const card = document.createElement('section'); card.className = 'card';
        const line = document.createElement('p'); line.className = 'stop'; line.textContent = blocked.message;
        card.append(line); $('out').append(card);
      }
    } finally { $('load').disabled = false; }
  });
})();
</script></body></html>`;
