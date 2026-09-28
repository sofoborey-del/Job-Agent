export const trackerPageHtml = String.raw`<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Your job shortlist</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#f4f1ea; color:#18322b; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; padding:32px 18px; }
    main { width:min(1140px,100%); margin:auto; }
    .eyebrow { color:#14705a; font-weight:800; letter-spacing:.08em; text-transform:uppercase; font-size:.78rem; }
    h1 { font-size:clamp(2rem,5vw,3.2rem); line-height:1; margin:.45rem 0 1rem; letter-spacing:-.045em; }
    .intro { color:#4d5e57; font-size:1.05rem; max-width:720px; line-height:1.6; }
    .card { background:#fff; border:1px solid #dce4de; border-radius:20px; padding:clamp(18px,3vw,28px); margin-top:20px; box-shadow:0 16px 42px rgba(29,54,45,.08); }
    label { display:block; font-weight:750; margin:12px 0 6px; font-size:.92rem; }
    input, select { width:100%; border:1px solid #b7c6bf; border-radius:11px; padding:11px 12px; font:inherit; color:inherit; background:#fff; }
    input:focus, select:focus { outline:3px solid #b8e4d7; border-color:#14705a; }
    button { border:0; border-radius:999px; padding:11px 18px; background:#18322b; color:white; font:inherit; font-weight:800; cursor:pointer; }
    button.ghost { background:#e9f5ef; color:#0d4a3b; }
    button.quiet { background:#f0ede6; color:#3d4b45; }
    button:disabled { opacity:.55; cursor:wait; }
    .row { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); }
    .actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:16px; }
    .note { background:#e9f5ef; border-left:4px solid #14705a; padding:12px 14px; border-radius:8px; line-height:1.5; margin:14px 0 0; }
    .error { color:#8a1c1c; background:#fff0f0; border-left-color:#c63c3c; }
    .job { border:1px solid #e1e8e3; border-radius:16px; padding:16px 18px; margin-top:14px; }
    .job h3 { margin:0 0 4px; font-size:1.2rem; }
    .muted { color:#617169; font-size:.94rem; }
    .pill { display:inline-block; padding:5px 10px; border-radius:999px; font-weight:750; font-size:.82rem; background:#f0ede6; margin:6px 6px 0 0; }
    .pill.good { background:#dff2e7; color:#0d4a3b; }
    .pill.warn { background:#fff1c9; color:#6b4f00; }
    .pill.bad { background:#ffe4e4; color:#8a1c1c; }
    .topline { display:flex; justify-content:space-between; gap:14px; align-items:flex-start; flex-wrap:wrap; }
    .score { min-width:74px; height:74px; border-radius:50%; display:grid; place-items:center; background:#18322b; color:white; font-weight:850; }
    .counts { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
    a { color:#09604d; font-weight:750; }
    details { margin-top:10px; }
    summary { cursor:pointer; font-weight:750; }
    .empty { padding:22px; text-align:center; color:#617169; }
  </style>
</head>
<body>
<main>
  <div class="eyebrow">Discovery and shortlist only</div>
  <h1>Your job shortlist</h1>
  <p class="intro">Everything here was found by reading public job adverts and comparing them with facts you approved. Nothing has been applied for, and the agent cannot log in to a jobs site or send anything to an employer.</p>

  <section class="card">
    <div class="row">
      <div>
        <label for="token">Profile admin token</label>
        <input id="token" type="password" autocomplete="off">
      </div>
      <div>
        <label for="profile">Profile ID</label>
        <input id="profile" type="text" autocomplete="off">
      </div>
    </div>
    <div class="actions">
      <button id="load" type="button">Show my jobs</button>
      <button id="rescore" class="ghost" type="button">Score anything new</button>
      <button id="pause" class="quiet" type="button">Pause the agent</button>
      <button id="resume" class="quiet" type="button">Resume</button>
    </div>
    <p id="status" class="note" role="status" aria-live="polite">Enter your token and profile ID, then choose "Show my jobs".</p>
    <div id="counts" class="counts"></div>
    <div id="agentState" hidden></div>
  </section>

  <section class="card">
    <strong>Add a vacancy link</strong>
    <p class="muted">Paste a public MyJobScotland vacancy link. The agent reads the advert, compares it with the facts you approved, shows the result here, and saves the link so it notices if the advert changes or closes. It cannot log in or apply.</p>
    <div class="row">
      <div style="grid-column:1/-1">
        <label for="newUrl">Vacancy link</label>
        <input id="newUrl" type="url" placeholder="https://myjobscotland.gov.uk/.../jobs/...">
      </div>
    </div>
    <div class="actions"><button id="addUrl" type="button">Add and check it</button></div>
    <div id="addResult" hidden></div>
  </section>

  <section class="card">
    <strong>Filters</strong>
    <div class="row">
      <div>
        <label for="fStatus">Status</label>
        <select id="fStatus">
          <option value="">Any status</option>
          <option value="shortlisted" selected>Shortlisted</option>
          <option value="discovered">New</option>
          <option value="reviewed">Reviewed</option>
          <option value="rejected">Rejected</option>
          <option value="archived">Archived</option>
        </select>
      </div>
      <div>
        <label for="fLifecycle">Advert state</label>
        <select id="fLifecycle">
          <option value="">Any</option>
          <option value="open">Still open</option>
          <option value="changed">Changed since last seen</option>
          <option value="closed">Closed</option>
          <option value="expired">Past its closing date</option>
          <option value="duplicate">Duplicate</option>
        </select>
      </div>
      <div>
        <label for="fMinScore">Lowest score</label>
        <input id="fMinScore" type="number" min="0" max="100" placeholder="0">
      </div>
      <div>
        <label for="fMaxScore">Highest score</label>
        <input id="fMaxScore" type="number" min="0" max="100" placeholder="100">
      </div>
      <div>
        <label for="fEmployer">Employer contains</label>
        <input id="fEmployer" type="text" placeholder="e.g. Glasgow">
      </div>
      <div>
        <label for="fLocation">Location contains</label>
        <input id="fLocation" type="text" placeholder="e.g. Glasgow">
      </div>
      <div>
        <label for="fMinSalary">Salary at least (GBP)</label>
        <input id="fMinSalary" type="number" min="0" step="500" placeholder="25000">
      </div>
      <div>
        <label for="fMaxSalary">Salary at most (GBP)</label>
        <input id="fMaxSalary" type="number" min="0" step="500" placeholder="">
      </div>
      <div>
        <label for="fSalaryGate">Salary certainty</label>
        <select id="fSalaryGate">
          <option value="">Any</option>
          <option value="pass">Meets your minimum</option>
          <option value="unknown">Not certain</option>
          <option value="reject">Below your minimum</option>
        </select>
      </div>
      <div>
        <label for="fFrom">Found on or after</label>
        <input id="fFrom" type="date">
      </div>
      <div>
        <label for="fTo">Found on or before</label>
        <input id="fTo" type="date">
      </div>
      <div>
        <label for="fClosing">Closing before</label>
        <input id="fClosing" type="date">
      </div>
      <div>
        <label for="fSource">Source</label>
        <select id="fSource"><option value="">Any source</option></select>
      </div>
      <div>
        <label for="fQuery">Search title or employer</label>
        <input id="fQuery" type="search" placeholder="e.g. compliance">
      </div>
      <div>
        <label for="fSort">Order by</label>
        <select id="fSort">
          <option value="score_desc">Best match first</option>
          <option value="score_asc">Lowest match first</option>
          <option value="discovered_desc">Newest first</option>
          <option value="closing_soon">Closing soonest</option>
        </select>
      </div>
    </div>
    <div class="actions">
      <button id="apply" type="button">Apply filters</button>
      <button id="clear" class="quiet" type="button">Clear filters</button>
    </div>
  </section>

  <section id="results" class="card">
    <div class="empty">No jobs loaded yet.</div>
  </section>
</main>
<script>
  var el = function (id) { return document.getElementById(id); };
  var statusLine = el('status');
  var query = new URLSearchParams(location.search);
  if (query.get('profileId')) el('profile').value = query.get('profileId');
  history.replaceState(null, '', '/tracker');

  var statusWords = {
    discovered: 'New', shortlisted: 'Shortlisted', reviewed: 'Reviewed',
    rejected: 'Rejected', archived: 'Archived'
  };
  var lifecycleWords = {
    open: 'Open', changed: 'Advert changed', closed: 'Closed',
    expired: 'Closing date passed', duplicate: 'Duplicate advert'
  };
  var salaryWords = {
    pass: 'Salary meets your minimum',
    reject: 'Salary below your minimum',
    unknown: 'Salary not certain'
  };

  function say(text, isError) {
    statusLine.className = isError ? 'note error' : 'note';
    statusLine.textContent = text;
  }

  function credentials() {
    var token = el('token').value.trim();
    var profile = el('profile').value.trim();
    if (!token || !profile) { say('Enter your admin token and profile ID first.', true); return null; }
    return { token: token, profile: profile };
  }

  function request(path, options) {
    var creds = credentials();
    if (!creds) return Promise.reject(new Error('missing credentials'));
    var settings = options || {};
    settings.headers = Object.assign(
      { 'authorization': 'Bearer ' + creds.token },
      settings.body ? { 'content-type': 'application/json' } : {}
    );
    return fetch(path.replace(':userId', encodeURIComponent(creds.profile)), settings)
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok) {
            throw new Error(body.message || (response.status === 401
              ? 'The token was not accepted.'
              : 'That request was refused (' + response.status + ').'));
          }
          return body;
        });
      });
  }

  function money(minor) {
    if (minor === null || minor === undefined) return null;
    return '£' + Math.round(minor / 100).toLocaleString('en-GB');
  }

  function filterQuery() {
    var parts = [];
    function add(name, value) { if (value !== '' && value !== null && value !== undefined) parts.push(name + '=' + encodeURIComponent(value)); }
    add('reviewStatus', el('fStatus').value);
    add('lifecycleStatus', el('fLifecycle').value);
    add('minScore', el('fMinScore').value);
    add('maxScore', el('fMaxScore').value);
    add('employer', el('fEmployer').value.trim());
    add('location', el('fLocation').value.trim());
    add('salaryGate', el('fSalaryGate').value);
    add('minSalary', el('fMinSalary').value);
    add('maxSalary', el('fMaxSalary').value);
    if (el('fFrom').value) add('discoveredFrom', el('fFrom').value + 'T00:00:00.000Z');
    if (el('fTo').value) add('discoveredTo', el('fTo').value + 'T23:59:59.999Z');
    if (el('fClosing').value) add('closingBefore', el('fClosing').value + 'T23:59:59.999Z');
    add('source', el('fSource').value);
    add('q', el('fQuery').value.trim());
    add('sort', el('fSort').value);
    return parts.length ? '?' + parts.join('&') : '';
  }

  function pill(text, tone) {
    var span = document.createElement('span');
    span.className = 'pill' + (tone ? ' ' + tone : '');
    span.textContent = text;
    return span;
  }

  function actionButton(job, target, label) {
    var button = document.createElement('button');
    button.className = 'ghost';
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', function () {
      button.disabled = true;
      request('/v1/tracker/:userId/jobs/' + job.jobId + '/status', {
        method: 'POST',
        body: JSON.stringify({ status: target, reason: 'changed on the tracker page' })
      }).then(function () {
        say('Updated. Nothing was sent to the employer.');
        loadJobs();
      }).catch(function (error) {
        say(error.message, true);
        button.disabled = false;
      });
    });
    return button;
  }

  function renderJobs(body) {
    var container = el('results');
    container.replaceChildren();
    var heading = document.createElement('div');
    heading.className = 'muted';
    heading.textContent = body.total + ' job(s) match these filters. The agent has not applied for any of them.';
    container.append(heading);
    if (!body.jobs.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nothing matches these filters yet.';
      container.append(empty);
      return;
    }
    body.jobs.forEach(function (job) {
      var card = document.createElement('div');
      card.className = 'job';
      var top = document.createElement('div');
      top.className = 'topline';
      var left = document.createElement('div');
      var title = document.createElement('h3');
      title.textContent = job.title;
      var meta = document.createElement('div');
      meta.className = 'muted';
      meta.textContent = [job.employer, job.location].filter(Boolean).join(' · ');
      left.append(title, meta);

      var pills = document.createElement('div');
      pills.append(pill(statusWords[job.reviewStatus] || job.reviewStatus, job.reviewStatus === 'shortlisted' ? 'good' : job.reviewStatus === 'rejected' ? 'bad' : ''));
      pills.append(pill(lifecycleWords[job.lifecycleStatus] || job.lifecycleStatus, job.lifecycleStatus === 'open' ? '' : 'warn'));
      if (job.salaryGate) pills.append(pill(salaryWords[job.salaryGate] || job.salaryGate, job.salaryGate === 'pass' ? 'good' : job.salaryGate === 'reject' ? 'bad' : 'warn'));
      var salaryRange = [money(job.salaryMinMinor), money(job.salaryMaxMinor)].filter(Boolean).join(' to ');
      if (salaryRange) pills.append(pill(salaryRange));
      if (job.closesAt) pills.append(pill('Closes ' + new Date(job.closesAt).toLocaleDateString('en-GB')));
      if (job.sourceKey) pills.append(pill('Found by ' + job.sourceKey));
      pills.append(pill('First seen ' + new Date(job.firstSeenAt).toLocaleDateString('en-GB')));
      if (job.descriptionCompleteness === 'snippet') pills.append(pill('Excerpt only', 'warn'));
      left.append(pills);

      var score = document.createElement('div');
      score.className = 'score';
      score.textContent = job.score === null ? '--' : job.score + '/100';
      top.append(left, score);
      card.append(top);

      var actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(actionButton(job, 'shortlisted', 'Shortlist'));
      actions.append(actionButton(job, 'reviewed', 'Mark reviewed'));
      actions.append(actionButton(job, 'rejected', 'Not for me'));
      actions.append(actionButton(job, 'archived', 'Archive'));
      var link = document.createElement('a');
      link.href = job.canonicalUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open the original advert';
      actions.append(link);
      card.append(actions);

      if (job.descriptionCompleteness === 'snippet') {
        var incomplete = document.createElement('div');
        incomplete.className = 'note';
        var why = document.createElement('p');
        why.textContent = 'Only an excerpt of this advert was available, so its requirements were never read. It has not been scored against your profile and cannot start an application. Paste the employer’s own advert address below and the agent will read it — but only if that site has already been reviewed.';
        incomplete.append(why);
        var row = document.createElement('div');
        row.className = 'actions';
        var input = document.createElement('input');
        input.type = 'url';
        input.placeholder = 'https://www.myjobscotland.gov.uk/councils/.../job-title';
        input.setAttribute('aria-label', 'Official employer advert address');
        var go = document.createElement('button');
        go.type = 'button';
        go.textContent = 'Read the official advert';
        var said = document.createElement('p');
        said.className = 'muted';
        go.addEventListener('click', function () {
          var value = input.value.trim();
          if (!value) { said.textContent = 'Paste the advert address first.'; return; }
          go.disabled = true;
          said.textContent = 'Checking that address… nothing is fetched unless the site is reviewed.';
          request('/v1/tracker/:userId/jobs/' + job.jobId + '/official-url', {
            method: 'POST',
            body: JSON.stringify({ url: value })
          }).then(function (result) {
            said.textContent = result.message || 'Done.';
            loadJobs();
          }).catch(function (error) {
            said.textContent = error.message;
          }).then(function () { go.disabled = false; });
        });
        row.append(input, go);
        incomplete.append(row, said);
        card.append(incomplete);
      }

      var prepare = document.createElement('button');
      prepare.type = 'button';
      prepare.textContent = 'Prepare application';
      var preparation = document.createElement('div');
      preparation.className = 'note';
      preparation.hidden = true;
      prepare.addEventListener('click', function () {
        prepare.disabled = true;
        preparation.hidden = false;
        preparation.textContent = 'Checking this job…';
        Promise.all([request('/v1/tracker/:userId/jobs/' + job.jobId, {}), request('/v1/applications/:userId/preparation/' + job.jobId, {})]).then(function (results) {
          var detail = results[0];
          var packet = results[1];
          preparation.replaceChildren();
          var view = packet.preparation || {};
          var labels = {
            already_submitted: 'Already submitted',
            blocked_closed: 'Unavailable: closed',
            blocked_ineligible: 'Unavailable: not eligible',
            unavailable: 'Assisted filling unavailable',
            awaiting_login: 'Sign in on the employer site',
            preparing: 'Preparing',
            needs_user_input: 'Needs your answers',
            ready_for_review: 'Ready for you to review'
          };
          var state = document.createElement('p');
          state.textContent = (labels[view.status] || 'Preparing') + ' — ' + (view.message || packet.message);
          preparation.append(state);
          if (view.adapter) {
            var adapterLine = document.createElement('p');
            adapterLine.className = 'muted';
            adapterLine.textContent = 'Reviewed adapter: ' + view.adapter.providerName + ' (' + view.adapter.id + ' ' + view.adapter.version + '). Assisted filling is ' + (view.prefillPermitted ? 'permitted' : 'off') + '; final submission is always yours.';
            preparation.append(adapterLine);
          }
          if (view.status === 'already_submitted' || view.status === 'blocked_closed' || view.status === 'blocked_ineligible') {
            prepare.textContent = labels[view.status];
            return;
          }
          if (packet.status === 'submitted' || packet.status === 'blocked_closed') {
            prepare.textContent = packet.status === 'submitted' ? 'Already submitted' : 'Unavailable';
            return;
          }
          if (Array.isArray(packet.checklist) && packet.checklist.length) {
            var listTitle = document.createElement('p');
            listTitle.textContent = 'What you do by hand:';
            var steps = document.createElement('ol');
            packet.checklist.forEach(function (item) {
              var li = document.createElement('li');
              li.textContent = item.step + '  (' + item.who + ')';
              steps.append(li);
            });
            preparation.append(listTitle, steps);
          }

          var profile = document.createElement('details');
          var profileTitle = document.createElement('summary');
          profileTitle.textContent = 'Review your saved application details';
          profile.append(profileTitle);
          (packet.facts || []).forEach(function (fact) {
            var row = document.createElement('pre');
            row.style.whiteSpace = 'pre-wrap';
            row.textContent = fact.key.replace(/_/g, ' ') + '\\n' + (typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value, null, 2));
            profile.append(row);
          });
          preparation.append(profile);
          var heading = document.createElement('h4');
          heading.textContent = 'Application preparation: ' + detail.title;
          var guidance = document.createElement('p');
          var expired = detail.closesAt && new Date(detail.closesAt).getTime() <= Date.now();
          var unavailable = detail.lifecycleStatus !== 'open' || expired;
          guidance.textContent = unavailable
            ? 'This vacancy is closed, expired or changed. Check the original advert before proceeding.'
            : 'Review the requirements below, then open the advert and choose Apply. You will log in and complete the form yourself. Browser prefill is not available for this employer yet.';
          preparation.append(heading, guidance);
          var run = detail.matchRun;
          var requirements = document.createElement('ul');
          if (run) {
            (run.explanation.requirements || []).forEach(function (requirement) {
              var item = document.createElement('li');
              item.textContent = (requirement.outcome === 'met' ? 'Supported by your approved profile: ' : 'Check before applying: ') + requirement.text;
              requirements.append(item);
            });
            (run.explanation.hardRejectReasons || []).forEach(function (reason) {
              var item = document.createElement('li');
              item.textContent = 'Eligibility concern: ' + reason.replace(/_/g, ' ');
              requirements.append(item);
            });
          }
          if (!requirements.children.length) {
            var item = document.createElement('li');
            item.textContent = 'No essential criteria have been confirmed here. Read the full person specification before applying.';
            requirements.append(item);
          }
          preparation.append(requirements);
          var applicationLink = document.createElement('a');
          var destination;
          try { destination = new URL(detail.canonicalUrl); } catch (_) { destination = null; }
          if (destination && destination.protocol === 'https:') {
            applicationLink.href = destination.href;
            applicationLink.target = '_blank';
            applicationLink.rel = 'noopener noreferrer';
            applicationLink.textContent = 'Open application site';
            preparation.append(applicationLink);
          }
          var reminder = document.createElement('p');
          reminder.textContent = 'Check your existing applications on the employer site to avoid applying twice. This preparation does not send an application or record it as submitted.';
          preparation.append(reminder);
        }).catch(function (error) { preparation.textContent = error.message; })
          .finally(function () { prepare.disabled = false; });
      });
      actions.prepend(prepare);
      card.append(preparation);

      var recordBox = document.createElement('details');
      var recordTitle = document.createElement('summary');
      recordTitle.textContent = 'I submitted this application myself';
      recordBox.append(recordTitle);
      var reference = document.createElement('input');
      reference.placeholder = 'Employer confirmation or job reference';
      reference.setAttribute('aria-label', 'Submission reference');
      var submittedDate = document.createElement('input');
      submittedDate.type = 'datetime-local';
      submittedDate.setAttribute('aria-label', 'Submission date and time');
      var recordButton = document.createElement('button');
      recordButton.type = 'button';
      recordButton.textContent = 'Confirm already submitted';
      var recordMessage = document.createElement('p');
      recordMessage.textContent = 'Only record a completed submission. This prevents another application; it does not send one.';
      recordButton.addEventListener('click', function () {
        var date = new Date(submittedDate.value);
        if (!reference.value.trim() || !submittedDate.value || isNaN(date.getTime())) {
          recordMessage.textContent = 'Enter your reference and submission date first.';
          return;
        }
        recordButton.disabled = true;
        request('/v1/applications/:userId/external-submission', {method: 'POST', body: JSON.stringify({jobId: job.jobId, providerReference: reference.value.trim(), submittedAt: date.toISOString(), confirmed: true})})
          .then(function () { recordMessage.textContent = 'Recorded as submitted. A new application is blocked.'; prepare.textContent = 'Already submitted'; })
          .catch(function (error) { recordMessage.textContent = error.message; })
          .finally(function () { recordButton.disabled = false; });
      });
      recordBox.append(recordMessage, reference, submittedDate, recordButton);
      card.append(recordBox);
      request('/v1/applications/:userId/external-submission/' + job.jobId, {}).then(function (result) {
        if (!result.submission) return;
        pills.append(pill('Submitted — ' + result.submission.providerReference));
        prepare.textContent = 'Already submitted';
        recordBox.hidden = true;
      }).catch(function () { /* Preparation still checks submission status before offering answers. */ });

      var details = document.createElement('details');
      var summary = document.createElement('summary');
      summary.textContent = 'Why this decision';
      details.append(summary);
      var explanation = document.createElement('div');
      explanation.className = 'muted';
      explanation.textContent = 'Loading the reasons…';
      details.append(explanation);
      details.addEventListener('toggle', function () {
        if (!details.open || details.dataset.loaded) return;
        details.dataset.loaded = 'yes';
        request('/v1/tracker/:userId/jobs/' + job.jobId, {}).then(function (detail) {
          explanation.replaceChildren();
          var run = detail.matchRun;
          if (!run) { explanation.textContent = 'This job has not been scored yet.'; return; }
          var list = document.createElement('ul');
          (run.explanation.explanation || []).forEach(function (line) {
            var li = document.createElement('li'); li.textContent = line; list.append(li);
          });
          (run.explanation.hardRejectReasons || []).forEach(function (line) {
            var li = document.createElement('li'); li.textContent = 'Rule that ruled it out: ' + line.replace(/_/g, ' '); list.append(li);
          });
          (run.explanation.autoBlockers || []).forEach(function (line) {
            var li = document.createElement('li'); li.textContent = 'Stops anything automatic: ' + line.replace(/_/g, ' '); list.append(li);
          });
          (run.explanation.requirements || []).forEach(function (requirement) {
            var li = document.createElement('li');
            li.textContent = (requirement.outcome === 'met'
              ? 'Matched to evidence you approved: '
              : 'Needs your review: ') + requirement.text;
            list.append(li);
          });
          explanation.append(list);
          var footer = document.createElement('div');
          footer.className = 'muted';
          footer.textContent = 'Decided using matcher ' + run.matcherVersion + ', settings ' + run.policyVersion + ', advert version ' + run.jobVersion + '.';
          explanation.append(footer);
        }).catch(function (error) { explanation.textContent = error.message; });
      });
      card.append(details);
      container.append(card);
    });
  }

  function renderCounts(counts) {
    var box = el('counts');
    box.replaceChildren();
    Object.keys(counts).forEach(function (key) {
      box.append(pill((statusWords[key] || key) + ': ' + counts[key]));
    });
  }

  function loadJobs() {
    say('Loading your jobs…');
    request('/v1/tracker/:userId/jobs' + filterQuery(), {}).then(function (body) {
      renderCounts(body.counts);
      renderJobs(body);
      say('Showing ' + body.jobs.length + ' of ' + body.total + ' job(s). Preparing does not submit an application.');
    }).catch(function (error) { say(error.message, true); });
  }

  function loadAgentStatus() {
    request('/v1/agent/status', {}).then(function (body) {
      var panel = el('agentState');
      panel.replaceChildren();
      var lines = [];
      if (body.paused) lines.push('The agent is paused, so nothing is being searched or sent.');
      if (body.scheduler && body.scheduler.configured) {
        if (body.scheduler.ready) {
          lines.push('Scheduled searching is on and ready. Sources switched on: ' + body.scheduler.enabledSources + '.');
        } else {
          lines.push('Scheduled searching is switched on but idle until these are fixed:');
          (body.scheduler.problems || []).forEach(function (problem) { lines.push('\u2022 ' + problem.message); });
        }
      } else {
        lines.push('Scheduled searching is off. Adding links here still works.');
      }
      if (!body.notificationsConfigured) lines.push('Discord notifications are off until you add the bot details in .env.');
      if ((body.undeliverableNotifications || []).length > 0) {
        lines.push((body.undeliverableNotifications || []).length + ' notification(s) could not be delivered.');
      }
      panel.className = body.scheduler && body.scheduler.configured && !body.scheduler.ready ? 'note error' : 'note';
      panel.textContent = lines.join(' ');
      panel.hidden = lines.length === 0;
    }).catch(function () { /* the status panel is optional */ });
  }

  function loadSources() {
    request('/v1/sources', {}).then(function (body) {
      var select = el('fSource');
      select.replaceChildren();
      var any = document.createElement('option');
      any.value = ''; any.textContent = 'Any source';
      select.append(any);
      body.sources.forEach(function (source) {
        var option = document.createElement('option');
        option.value = source.sourceKey;
        option.textContent = source.displayName + (source.enabled ? '' : ' (off)');
        select.append(option);
      });
    }).catch(function () { /* the source list is optional */ });
  }

  el('load').addEventListener('click', function () { loadSources(); loadAgentStatus(); loadJobs(); });
  el('apply').addEventListener('click', loadJobs);
  el('clear').addEventListener('click', function () {
    ['fMinScore','fMaxScore','fEmployer','fLocation','fMinSalary','fMaxSalary','fFrom','fTo','fClosing','fQuery'].forEach(function (id) { el(id).value = ''; });
    ['fStatus','fLifecycle','fSalaryGate','fSource'].forEach(function (id) { el(id).value = ''; });
    el('fSort').value = 'score_desc';
    loadJobs();
  });
  el('rescore').addEventListener('click', function () {
    var creds = credentials();
    if (!creds) return;
    say('Scoring anything new against your approved profile…');
    request('/v1/match/run', { method: 'POST', body: JSON.stringify({ userId: creds.profile }) })
      .then(function (body) {
        say('Scored ' + body.evaluated + ' advert(s); ' + body.shortlisted + ' shortlisted, ' + body.rejected + ' ruled out.');
        loadJobs();
      }).catch(function (error) { say(error.message, true); });
  });
  var actionWords = {
    reject: 'Not a match under your current rules',
    shortlist: 'Worth your review',
    prefill_with_approval: 'Strong enough to prepare later, with your approval',
    auto_apply: 'High match'
  };

  function renderAddResult(body) {
    var panel = el('addResult');
    panel.replaceChildren();
    panel.hidden = false;
    var match = body.match || {};

    if (match.state === 'profile_incomplete') {
      panel.className = 'note error';
      panel.textContent = 'The advert was saved, but it cannot be scored until your profile is finished. Still needed: '
        + (match.missingCategories || []).join(', ') + '.';
      return;
    }
    if (match.state !== 'decided') {
      panel.className = 'note';
      panel.textContent = 'The advert was saved but has not been scored. Choose "Score anything new" to try again.';
      return;
    }

    panel.className = 'job';
    var top = document.createElement('div');
    top.className = 'topline';
    var left = document.createElement('div');
    var title = document.createElement('h3');
    title.textContent = body.job.title;
    var meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = [body.job.employer, body.job.location].filter(Boolean).join(' \u00b7 ');
    left.append(title, meta);

    var pills = document.createElement('div');
    pills.append(pill(actionWords[match.action] || match.action, match.action === 'reject' ? 'bad' : 'good'));
    pills.append(pill(statusWords[match.reviewStatus] || match.reviewStatus, match.reviewStatus === 'shortlisted' ? 'good' : match.reviewStatus === 'rejected' ? 'bad' : ''));
    if (match.salaryGate) pills.append(pill(salaryWords[match.salaryGate] || match.salaryGate, match.salaryGate === 'pass' ? 'good' : match.salaryGate === 'reject' ? 'bad' : 'warn'));
    if (body.outcome === 'unchanged' || match.reused) pills.append(pill('Already saved, nothing changed'));
    if (body.outcome === 'duplicate') pills.append(pill('Same role as one you already have', 'warn'));
    left.append(pills);

    var score = document.createElement('div');
    score.className = 'score';
    score.textContent = match.score + '/100';
    top.append(left, score);
    panel.append(top);

    var reasons = document.createElement('ul');
    (match.reasons || []).forEach(function (line) {
      var li = document.createElement('li'); li.textContent = line; reasons.append(li);
    });
    (match.hardRejectReasons || []).forEach(function (line) {
      var li = document.createElement('li'); li.textContent = 'Rule that ruled it out: ' + line.replace(/_/g, ' '); reasons.append(li);
    });
    if (match.unknownRequirements > 0) {
      var li = document.createElement('li');
      li.textContent = match.unknownRequirements + ' essential requirement(s) could not be confirmed from your approved profile, so they need your review.';
      reasons.append(li);
    }
    var closing = document.createElement('li');
    closing.textContent = 'Nothing was applied for. This only updates your own tracker.';
    reasons.append(closing);
    panel.append(reasons);

    var link = document.createElement('a');
    link.href = body.job.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open the original advert';
    panel.append(link);
  }

  el('addUrl').addEventListener('click', function () {
    var creds = credentials();
    if (!creds) return;
    var url = el('newUrl').value.trim();
    if (!url) { say('Paste a vacancy link first.', true); return; }
    el('addResult').hidden = true;
    el('addUrl').disabled = true;
    say('Reading that advert and comparing it with your profile…');
    request('/v1/discovery/manual-url', { method: 'POST', body: JSON.stringify({ userId: creds.profile, url: url }) })
      .then(function (body) {
        if (body.status !== 'ingested') { say('That link was not accepted: ' + (body.reason || 'unknown reason'), true); return; }
        el('newUrl').value = '';
        renderAddResult(body);
        say('Checked. No application was made.');
        loadJobs();
      })
      .catch(function (error) { say(error.message, true); })
      .then(function () { el('addUrl').disabled = false; });
  });
  el('pause').addEventListener('click', function () {
    request('/v1/agent/pause', { method: 'POST', body: JSON.stringify({ reason: 'paused from the tracker page' }) })
      .then(function () { say('Paused. No scheduled searching or notifications until you resume.'); loadAgentStatus(); })
      .catch(function (error) { say(error.message, true); });
  });
  el('resume').addEventListener('click', function () {
    request('/v1/agent/resume', { method: 'POST', body: JSON.stringify({}) })
      .then(function () { say('Resumed.'); loadAgentStatus(); })
      .catch(function (error) { say(error.message, true); });
  });
</script>
</body>
</html>`;
