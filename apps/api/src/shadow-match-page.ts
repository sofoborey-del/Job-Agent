export const shadowMatchPageHtml = String.raw`<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Check a MyJobScotland role</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#f4f1ea; color:#18322b; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; padding:32px 18px; }
    main { width:min(820px,100%); margin:auto; }
    .eyebrow { color:#14705a; font-weight:800; letter-spacing:.08em; text-transform:uppercase; font-size:.78rem; }
    h1 { font-size:clamp(2rem,6vw,3.7rem); line-height:1; margin:.45rem 0 1rem; letter-spacing:-.045em; }
    .intro { color:#4d5e57; font-size:1.08rem; max-width:680px; line-height:1.6; }
    .card { background:#fff; border:1px solid #dce4de; border-radius:20px; padding:clamp(20px,5vw,36px); margin-top:24px; box-shadow:0 16px 42px rgba(29,54,45,.08); }
    label { display:block; font-weight:750; margin:16px 0 7px; }
    input { width:100%; border:1px solid #b7c6bf; border-radius:11px; padding:13px 14px; font:inherit; color:inherit; }
    input:focus { outline:3px solid #b8e4d7; border-color:#14705a; }
    button { margin-top:22px; border:0; border-radius:999px; padding:13px 21px; background:#18322b; color:white; font:inherit; font-weight:800; cursor:pointer; }
    button:disabled { opacity:.55; cursor:wait; }
    .note { background:#e9f5ef; border-left:4px solid #14705a; padding:13px 15px; border-radius:8px; line-height:1.5; }
    .error { color:#8a1c1c; background:#fff0f0; border-left-color:#c63c3c; }
    #result[hidden], #message:empty { display:none; }
    .topline { display:flex; gap:14px; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; }
    .score { width:86px; height:86px; border-radius:50%; display:grid; place-items:center; background:#18322b; color:white; font-size:1.35rem; font-weight:850; }
    h2 { margin:0; font-size:1.7rem; }
    .muted { color:#617169; }
    .status { display:inline-block; margin-top:10px; padding:7px 11px; background:#fff1c9; border-radius:999px; font-weight:750; }
    h3 { margin:26px 0 10px; }
    ul { padding-left:21px; line-height:1.55; }
    a { color:#09604d; font-weight:750; }
  </style>
</head>
<body>
<main>
  <div class="eyebrow">Safe discovery preview</div>
  <h1>Check a role against your profile</h1>
  <p class="intro">Paste a public MyJobScotland vacancy link. The agent will read the advert and compare it with facts you approved. It cannot log in, fill a form, or apply from this screen.</p>
  <section class="card">
    <div class="note">Shadow mode is on. Unknown requirements are shown for your review and are never treated as qualifications you have.</div>
    <form id="form">
      <label for="token">Profile admin token</label>
      <input id="token" type="password" autocomplete="off" required>
      <label for="profile">Profile ID</label>
      <input id="profile" type="text" autocomplete="off" required>
      <label for="url">MyJobScotland job link</label>
      <input id="url" type="url" placeholder="https://myjobscotland.gov.uk/.../jobs/..." required>
      <button id="submit" type="submit">Check this role</button>
    </form>
    <p id="message" class="note" role="status" aria-live="polite"></p>
  </section>
  <section id="result" class="card" hidden>
    <div class="topline">
      <div><h2 id="title"></h2><div id="meta" class="muted"></div><div id="action" class="status"></div></div>
      <div id="score" class="score"></div>
    </div>
    <h3>Why</h3><ul id="reasons"></ul>
    <h3>Essential or required wording found</h3><ul id="requirements"></ul>
    <a id="source" target="_blank" rel="noopener noreferrer">View the original public advert</a>
  </section>
</main>
<script>
  const form = document.getElementById('form');
  const button = document.getElementById('submit');
  const message = document.getElementById('message');
  const result = document.getElementById('result');
  const query = new URLSearchParams(location.search);
  const profileFromUrl = query.get('profileId');
  if (profileFromUrl) document.getElementById('profile').value = profileFromUrl;
  history.replaceState(null, '', '/shadow-match');
  const labels = { reject:'Not a match under current rules', shortlist:'Worth your review', prefill_with_approval:'Strong enough to prepare later', auto_apply:'High match' };
  function putList(element, items) {
    element.replaceChildren();
    for (const item of items) { const li = document.createElement('li'); li.textContent = item; element.append(li); }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); result.hidden = true; message.className = 'note';
    message.textContent = 'Reading the public advert and checking your approved profile…'; button.disabled = true;
    try {
      const response = await fetch('/v1/shadow-match/myjobscotland', {
        method:'POST', headers:{'content-type':'application/json','authorization':'Bearer ' + document.getElementById('token').value},
        body:JSON.stringify({userId:document.getElementById('profile').value.trim(),url:document.getElementById('url').value.trim()})
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || (response.status === 401 ? 'The token was not accepted.' : 'The role could not be checked.'));
      document.getElementById('title').textContent = body.job.title;
      document.getElementById('meta').textContent = [body.job.employer, body.job.location, body.job.salary].filter(Boolean).join(' · ');
      document.getElementById('score').textContent = body.match.score + '/100';
      document.getElementById('action').textContent = labels[body.match.action] || body.match.action;
      const reasons = [...body.match.explanation, ...body.match.hardRejectReasons.map(x => 'Rule: ' + x.replaceAll('_',' '))];
      putList(document.getElementById('reasons'), reasons.length ? reasons : ['No explanation was returned.']);
      putList(document.getElementById('requirements'), body.requirements.length ? body.requirements.map(r => (r.outcome === 'met' ? 'Supported by approved evidence: ' : 'Needs your review: ') + r.text) : ['No explicit mandatory wording was detected automatically. Review the advert yourself before applying.']);
      document.getElementById('source').href = body.job.url;
      message.textContent = 'Check complete. No application action was taken.'; result.hidden = false;
    } catch (error) { message.className = 'note error'; message.textContent = error.message; }
    finally { button.disabled = false; }
  });
</script>
</body>
</html>`;
