export const leavingReasonsPageHtml = String.raw`<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link your reasons for leaving</title><style>
:root{font-family:system-ui,sans-serif;background:#f4f1ea;color:#18322b}*{box-sizing:border-box}body{margin:0;padding:30px 16px 70px}
main{max-width:860px;margin:auto}h1{font-size:clamp(1.9rem,5vw,2.8rem);margin-bottom:8px}h2{margin:0 0 4px}p{line-height:1.5}
.card{background:#fff;border:1px solid #dce4de;border-radius:16px;padding:22px;margin-top:18px}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
label{display:block;font-weight:650;margin-top:12px}input,select{width:100%;padding:10px;border:1px solid #a9bcb0;border-radius:8px;font:inherit;margin-top:5px}
button{background:#18322b;color:white;border:0;border-radius:999px;padding:11px 18px;font:inherit;font-weight:700;cursor:pointer;margin:14px 8px 0 0}
button:disabled{opacity:.5}.muted{color:#53665b}.notice{background:#fff4da;border-left:4px solid #ac7723;padding:12px;margin-top:12px}
.role{border-top:1px solid #e3eae4;padding:14px 0}.role:first-of-type{border-top:0}
.tag{display:inline-block;font-size:.72rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;border-radius:999px;padding:3px 9px;margin-right:6px}
.tag.done{background:#dcf0e4;color:#14562f}.tag.sug{background:#e2ecfa;color:#14407a}.tag.none{background:#fde9cf;color:#8a4b09}
.why{font-size:.85rem;color:#53665b;margin:6px 0 0}a{color:#09604d}
</style></head><body><main>
<p><a href="/tracker">← Back to your jobs</a></p>
<h1>Link your reasons for leaving</h1>
<p class="muted">You have recorded some reasons for leaving, but they are filed against employer names that do not exactly match the names on your employment history — usually because a CV line carries a town or a work pattern after the employer. Until they match, the agent refuses to use them, because a reason must never be attached to an employer it does not name.</p>
<p class="muted">Tell it which reason belongs to which role and it will file them correctly. Your wording is never changed, and what you originally typed is kept.</p>
<p class="notice">Only link two entries if they really are the same employer. The agent will not check this for you — that is the whole point of asking.</p>

<section class="card"><div class="row">
<label>Profile admin token<input id="token" type="password" autocomplete="off"></label>
<label>Profile ID<input id="profile" type="text" autocomplete="off"></label>
</div>
<button id="load" type="button">Show my roles and reasons</button>
<p id="status" role="status"></p></section>

<div id="out"></div>
</main><script>
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  if (/^[0-9a-f-]{36}$/i.test(params.get('profileId') || '')) $('profile').value = params.get('profileId');
  if (params.toString()) history.replaceState({}, '', '/leaving-reasons');
  let state = null;

  const base = () => '/v1/profile/' + encodeURIComponent($('profile').value.trim()) + '/leaving-reasons';

  async function request(method, body) {
    const response = await fetch(base(), {
      method,
      headers: { authorization: 'Bearer ' + $('token').value.trim(), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401 ? 'The admin token was not accepted.' : (data.message || data.error || 'The request failed.'));
    return data;
  }

  function render() {
    const out = $('out'); out.replaceChildren();
    const card = document.createElement('section'); card.className = 'card';
    const title = document.createElement('h2'); title.textContent = 'Your roles';
    card.append(title);
    (state.warnings || []).forEach((warning) => {
      const line = document.createElement('p'); line.className = 'notice'; line.textContent = warning; card.append(line);
    });

    state.rows.forEach((row) => {
      const block = document.createElement('div'); block.className = 'role';
      const head = document.createElement('div');
      const tag = document.createElement('span');
      tag.className = 'tag ' + (row.linkedKey ? 'done' : row.suggestedKey ? 'sug' : 'none');
      tag.textContent = row.linkedKey ? 'Already linked' : row.suggestedKey ? 'Suggested' : 'Choose one';
      const name = document.createElement('strong');
      name.textContent = row.title + ' — ' + row.employer;
      head.append(tag, name);
      const dates = document.createElement('div'); dates.className = 'muted';
      dates.textContent = (row.startDate || 'start not recorded') + ' to ' + (row.endDate || 'present');
      block.append(head, dates);

      const select = document.createElement('select');
      select.dataset.rowIndex = String(row.rowIndex);
      const none = document.createElement('option');
      none.value = ''; none.textContent = 'No reason for leaving recorded for this role';
      select.append(none);
      (state.reasons || []).forEach((reason) => {
        const option = document.createElement('option');
        option.value = reason.key;
        option.textContent = reason.employer + ' — ' + reason.reasonForLeaving;
        select.append(option);
      });
      select.value = row.linkedKey || row.suggestedKey || '';
      const label = document.createElement('label');
      label.textContent = 'Reason for leaving this role';
      label.append(select);
      block.append(label);

      if (row.suggestionBasis && !row.linkedKey) {
        const why = document.createElement('p'); why.className = 'why'; why.textContent = row.suggestionBasis;
        block.append(why);
      }
      card.append(block);
    });

    const save = document.createElement('button');
    save.type = 'button'; save.textContent = 'Save these links';
    save.addEventListener('click', async () => {
      const links = [...card.querySelectorAll('select')]
        .filter((select) => select.value !== '')
        .map((select) => ({ rowIndex: Number(select.dataset.rowIndex), reasonKey: select.value }));
      save.disabled = true;
      try {
        const result = await request('POST', { sourceRevision: state.sourceRevision, links: links, confirmed: true });
        $('status').textContent = 'Saved. ' + result.updated + ' reason(s) re-filed against the right employer. Reload your answer pack to see them.';
        await load();
      } catch (error) { $('status').textContent = error.message; }
      finally { save.disabled = false; }
    });
    card.append(save);
    const caveat = document.createElement('p'); caveat.className = 'muted';
    caveat.textContent = 'Leaving a role set to “no reason recorded” is fine. An application form asking for one will simply say it is yours to fill in.';
    card.append(caveat);
    out.append(card);
  }

  async function load() { state = await request('GET'); render(); }

  $('load').addEventListener('click', async () => {
    $('load').disabled = true; $('status').textContent = 'Reading your profile…';
    try { await load(); $('status').textContent = 'Nothing has been changed yet.'; }
    catch (error) { $('status').textContent = error.message; }
    finally { $('load').disabled = false; }
  });
})();
</script></body></html>`;
