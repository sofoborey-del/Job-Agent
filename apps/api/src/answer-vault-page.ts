export const answerVaultPageHtml = String.raw`<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your reusable answers</title><style>
:root{font-family:system-ui,sans-serif;background:#f4f1ea;color:#18322b}*{box-sizing:border-box}body{margin:0;padding:30px 16px 70px}
main{max-width:820px;margin:auto}h1{font-size:clamp(2rem,5vw,3rem);margin-bottom:8px}p{line-height:1.5}
.card{background:#fff;border:1px solid #dce4de;border-radius:16px;padding:22px;margin-top:18px}.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
label{display:block;font-weight:650;margin-top:12px}input,select,textarea{width:100%;padding:10px;border:1px solid #a9bcb0;border-radius:8px;font:inherit;margin-top:5px}
textarea{min-height:90px}button{background:#18322b;color:white;border:0;border-radius:999px;padding:11px 18px;font:inherit;font-weight:700;cursor:pointer;margin:14px 8px 0 0}
button:disabled{opacity:.5}.muted{color:#53665b}.notice{background:#fff4da;border-left:4px solid #ac7723;padding:12px;margin-top:12px}
.entry{border-top:1px solid #dae3dc;padding:12px 0;white-space:pre-wrap}a{color:#09604d}
</style></head><body><main>
<p><a href="/tracker">← Back to your jobs</a></p><h1>Your reusable answers</h1>
<p class="muted">Save an answer once so a future application assistant can offer it back to you. Every answer is optional. This vault is encrypted locally, not sent to Discord or any employer, and is <strong>not used for automatic form filling yet</strong>.</p>
<p class="notice">Sexual orientation, disability and other equality answers are particularly private. Enter them only if you want them saved. You may use “Prefer not to say” where a form offers it. Saving an answer here does not consent to any employer’s data-processing notice or declaration.</p>
<section class="card"><div class="row"><label>Profile admin token<input id="token" type="password" autocomplete="off"></label>
<label>Profile ID<input id="profile" type="text" autocomplete="off"></label></div>
<button id="load" type="button">Show saved answers</button><p id="status" role="status"></p></section>
<section id="editor" class="card" hidden><h2>Add or update an answer</h2>
<label>Question topic<select id="topic">
<option value="sexual_orientation">Sexual orientation</option><option value="disability_status">Disability status</option>
<option value="ethnicity">Ethnicity</option><option value="gender_identity">Gender identity</option>
<option value="religion">Religion or belief</option><option value="marital_status">Marital status</option>
<option value="customer_service_example">Customer-service example</option>
<option value="handling_sensitive_information_example">Handling-sensitive-information example</option>
</select></label>
<label>Your exact approved answer<textarea id="answer" maxlength="3000" autocomplete="off"></textarea></label>
<label><input id="confirm" type="checkbox" style="width:auto;margin-right:8px">I chose this answer myself and want it stored locally for future application preparation.</label>
<button id="save" type="button">Save this answer</button><button id="remove" type="button">Remove this topic’s answer</button>
<h2>Saved topics</h2><div id="entries"></div></section>
</main><script>
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const profile = new URLSearchParams(location.search).get('profileId');
  if (profile && /^[0-9a-f-]{36}$/i.test(profile)) { $('profile').value=profile; history.replaceState({}, '', '/answer-vault'); }
  let saved = [];
  const base = () => '/v1/profile/' + encodeURIComponent($('profile').value.trim()) + '/answer-vault';
  async function request(path, method, body) {
    const response = await fetch(path, { method, headers:{authorization:'Bearer '+$('token').value.trim(),...(body ? {'content-type':'application/json'} : {})},...(body ? {body:JSON.stringify(body)} : {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status===401 ? 'The admin token was not accepted.' : data.message || 'The request failed.');
    return data;
  }
  function render() {
    $('entries').replaceChildren();
    if (!saved.length) { $('entries').textContent='No answers saved.'; return; }
    saved.forEach((entry) => {
      const row=document.createElement('div');row.className='entry';
      const title=document.createElement('strong');title.textContent=entry.topic.replaceAll('_',' ') + (entry.sensitive ? ' (private)' : '');
      const text=document.createElement('p');text.textContent=entry.answer;
      row.append(title,text);$('entries').append(row);
    });
  }
  function populateTopic() { const found=saved.find((entry)=>entry.topic===$('topic').value);$('answer').value=found?.answer || '';$('confirm').checked=false; }
  async function load() {
    const result=await request(base(),'GET');saved=result.entries || [];$('editor').hidden=false;render();populateTopic();
    $('status').textContent='Loaded '+saved.length+' saved answer(s). Nothing has been sent to an employer.';
  }
  $('load').addEventListener('click',async()=>{ $('status').textContent='Loading…';try{await load();}catch(error){$('status').textContent=error.message;} });
  $('topic').addEventListener('change',populateTopic);
  $('save').addEventListener('click',async()=>{
    if (!$('confirm').checked) { $('status').textContent='Tick the confirmation box before saving.';return; }
    $('save').disabled=true;
    try { await request(base()+'/'+encodeURIComponent($('topic').value),'PUT',{answer:$('answer').value.trim(),confirmed:true});await load();$('status').textContent='Answer saved locally. It is not enabled for automatic filling.'; }
    catch(error){$('status').textContent=error.message;}finally{$('save').disabled=false;}
  });
  $('remove').addEventListener('click',async()=>{
    if (!window.confirm('Remove every saved version of this topic’s answer from the active database?')) return;
    $('remove').disabled=true;
    try { await request(base()+'/'+encodeURIComponent($('topic').value),'DELETE');$('answer').value='';$('confirm').checked=false;await load();$('status').textContent='Saved answer removed.'; }
    catch(error){$('status').textContent=error.message;}finally{$('remove').disabled=false;}
  });
})();
</script></body></html>`;
