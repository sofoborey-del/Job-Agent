export const applicationsPageHtml = String.raw`<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Practice applications</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#f4f1ea; color:#18322b; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; padding:32px 18px; }
    main { width:min(1000px,100%); margin:auto; }
    .eyebrow { color:#14705a; font-weight:800; letter-spacing:.08em; text-transform:uppercase; font-size:.78rem; }
    h1 { font-size:clamp(2rem,5vw,3.2rem); line-height:1; margin:.45rem 0 1rem; letter-spacing:-.045em; }
    .intro { color:#4d5e57; font-size:1.05rem; max-width:740px; line-height:1.6; }
    .card { background:#fff; border:1px solid #dce4de; border-radius:20px; padding:clamp(18px,3vw,28px); margin-top:20px; box-shadow:0 16px 42px rgba(29,54,45,.08); }
    .warn { background:#fff4d6; border:1px solid #e3c98f; border-left:5px solid #c8930f; padding:12px 15px; border-radius:10px; font-weight:700; }
    label { display:block; font-weight:750; margin:12px 0 6px; font-size:.92rem; }
    input, select, textarea { width:100%; border:1px solid #b7c6bf; border-radius:11px; padding:11px 12px; font:inherit; color:inherit; background:#fff; }
    button { border:0; border-radius:999px; padding:11px 18px; background:#18322b; color:white; font:inherit; font-weight:800; cursor:pointer; }
    button.ghost { background:#e9f5ef; color:#0d4a3b; }
    button.quiet { background:#f0ede6; color:#3d4b45; }
    button:disabled { opacity:.55; cursor:wait; }
    .row { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); }
    .actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:16px; }
    .note { background:#e9f5ef; border-left:4px solid #14705a; padding:12px 14px; border-radius:8px; line-height:1.5; margin:14px 0 0; }
    .error { color:#8a1c1c; background:#fff0f0; border-left-color:#c63c3c; }
    .item { border:1px solid #e1e8e3; border-radius:16px; padding:16px 18px; margin-top:14px; }
    .item h3 { margin:0 0 4px; font-size:1.15rem; }
    .muted { color:#617169; font-size:.94rem; }
    .pill { display:inline-block; padding:5px 10px; border-radius:999px; font-weight:750; font-size:.82rem; background:#f0ede6; margin:6px 6px 0 0; }
    .pill.good { background:#dff2e7; color:#0d4a3b; }
    .pill.warn { background:#fff1c9; color:#6b4f00; }
    .pill.bad { background:#ffe4e4; color:#8a1c1c; }
    table { width:100%; border-collapse:collapse; margin-top:10px; font-size:.93rem; }
    th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #eceff0; vertical-align:top; }
    th { font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; color:#617169; }
    code { background:#f0ede6; padding:2px 6px; border-radius:6px; font-size:.86rem; }
    h2 { font-size:1.25rem; margin:22px 0 4px; }
    .steps { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
    .step { padding:7px 12px; border-radius:999px; border:1px solid #cfdad4; font-weight:700; font-size:.85rem; }
    .step.done { background:#dff2e7; border-color:#9fd3bd; }
    .step.now { background:#18322b; color:#fff; border-color:#18322b; }
    .step.human { background:#fff1c9; border-color:#e3c98f; }
  </style>
</head>
<body>
<main>
  <div class="eyebrow">Practice applications — local fake ATS only</div>
  <h1>Practice applications</h1>
  <p class="intro">These runs happen against a pretend job site that ships with this project and runs on your own machine. No real employer is involved, nothing is sent anywhere, and automatic submitting is switched off.</p>

  <section class="card">
    <div class="warn">Real application automation and production submission are disabled. Every step below is the local fake ATS.</div>
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
    <div class="actions"><button id="load" type="button">Show my practice applications</button></div>
    <p id="status" class="note" role="status" aria-live="polite">Enter your token and profile ID, then choose "Show my practice applications".</p>
  </section>

  <section id="list" class="card"><div class="muted">Nothing loaded yet.</div></section>
  <section id="detail" class="card" hidden></section>
</main>
<script>
  var el = function (id) { return document.getElementById(id); };
  var statusLine = el('status');
  var current = null;
  var query = new URLSearchParams(location.search);
  if (query.get('profileId')) el('profile').value = query.get('profileId');
  history.replaceState(null, '', '/applications');

  var stageWords = {
    QUEUED: 'Waiting to start', STARTING: 'Starting', FILLING: 'Filling the form',
    WAITING_USER: 'Waiting for your answer', WAITING_TAKEOVER: 'Waiting for you in the browser',
    READY_FOR_REVIEW: 'Ready for your review', WAITING_APPROVAL: 'Waiting for your approval',
    READY_TO_SUBMIT: 'Approved, ready to submit', SUBMITTING: 'Submitting',
    SUBMITTED: 'Submitted to the fake ATS', SUBMISSION_UNKNOWN: 'Outcome unclear — needs you',
    CANCELLED: 'Cancelled', REJECTED: 'Rejected'
  };
  var reasonWords = {
    unknown_field: 'the form asked something the agent does not recognise',
    missing_evidence: 'your profile has nothing verified for it',
    sensitive_question: 'it is a sensitive question, so only you may answer it',
    expired_fact: 'the profile fact behind it has expired',
    unverified_fact: 'the profile fact behind it is not verified',
    use_policy_forbids: 'that fact is set to ask you each time',
    ambiguous_mapping: 'the agent could not tell what it is asking',
    human_only_step: 'this step has to be done by you',
    validation_rejected: 'the form kept rejecting this step'
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

  function pill(text, tone) {
    var span = document.createElement('span');
    span.className = 'pill' + (tone ? ' ' + tone : '');
    span.textContent = text;
    return span;
  }

  function heading(text) {
    var h = document.createElement('h2');
    h.textContent = text;
    return h;
  }

  function loadList() {
    say('Loading your practice applications…');
    request('/v1/applications/:userId', {}).then(function (body) {
      var container = el('list');
      container.replaceChildren();
      container.append(heading('Your practice applications'));
      if (!body.applications.length) {
        var empty = document.createElement('div');
        empty.className = 'muted';
        empty.textContent = 'None yet. A practice run is started from the tracker page.';
        container.append(empty);
        say('No practice applications yet.');
        return;
      }
      body.applications.forEach(function (application) {
        var item = document.createElement('div');
        item.className = 'item';
        var title = document.createElement('h3');
        title.textContent = application.jobTitle + ' — ' + application.employer;
        var meta = document.createElement('div');
        meta.className = 'muted';
        meta.textContent = 'Last updated ' + new Date(application.updatedAt).toLocaleString('en-GB');
        item.append(title, meta);
        var pills = document.createElement('div');
        pills.append(pill(stageWords[application.stage] || application.stage,
          application.stage === 'SUBMITTED' ? 'good' : application.pauseReason ? 'warn' : ''));
        if (application.openQuestions > 0) pills.append(pill(application.openQuestions + ' question(s) for you', 'warn'));
        if (application.takeoverRequested) pills.append(pill('You have taken over', 'warn'));
        item.append(pills);
        var open = document.createElement('div');
        open.className = 'actions';
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'ghost';
        button.textContent = 'Open';
        button.addEventListener('click', function () { loadDetail(application.applicationId); });
        open.append(button);
        item.append(open);
        container.append(item);
      });
      say('Showing ' + body.applications.length + ' practice application(s). Nothing was sent to an employer.');
    }).catch(function (error) { say(error.message, true); });
  }

  function renderSteps(container, steps) {
    container.append(heading('Steps'));
    var row = document.createElement('div');
    row.className = 'steps';
    steps.forEach(function (step) {
      var chip = document.createElement('span');
      chip.className = 'step' + (step.current ? ' now' : step.completed ? ' done' : step.humanOnly ? ' human' : '');
      chip.textContent = step.id + (step.humanOnly ? ' (you)' : step.completed ? ' ✓' : '');
      row.append(chip);
    });
    container.append(row);
  }

  function renderQuestions(container, detail) {
    container.append(heading('Questions waiting for you'));
    if (!detail.questions.length) {
      var none = document.createElement('div');
      none.className = 'muted';
      none.textContent = 'Nothing is waiting for you.';
      container.append(none);
      return;
    }
    detail.questions.forEach(function (question) {
      var box = document.createElement('div');
      box.className = 'item';
      var prompt = document.createElement('div');
      prompt.textContent = question.prompt;
      var why = document.createElement('div');
      why.className = 'muted';
      why.textContent = 'Why you are being asked: ' + (reasonWords[question.reason] || question.reason) + '.';
      box.append(prompt, why);
      if (question.responseKind === 'human_action') {
        var human = document.createElement('div');
        human.className = 'note';
        human.textContent = 'This one has to be done by you in the browser. Use "I will take over", complete it, then choose Resume.';
        box.append(human);
      } else {
        var label = document.createElement('label');
        label.textContent = 'Your answer';
        var input;
        if (question.allowedValues.length) {
          input = document.createElement('select');
          question.allowedValues.forEach(function (value) {
            var option = document.createElement('option');
            option.value = value; option.textContent = value;
            input.append(option);
          });
        } else {
          input = document.createElement('input');
          input.type = 'text';
        }
        var send = document.createElement('button');
        send.type = 'button';
        send.textContent = 'Use this answer for this application only';
        send.addEventListener('click', function () {
          send.disabled = true;
          request('/v1/applications/:userId/' + detail.application.applicationId + '/questions/' + question.questionId + '/answer', {
            method: 'POST',
            body: JSON.stringify({ value: input.value, saveToProfile: false, responseVersion: 1 })
          }).then(function (body) {
            say(body.message);
            loadDetail(detail.application.applicationId);
          }).catch(function (error) { say(error.message, true); send.disabled = false; });
        });
        var actions = document.createElement('div');
        actions.className = 'actions';
        actions.append(send);
        box.append(label, input, actions);
      }
      container.append(box);
    });
  }

  function renderFields(container, detail) {
    container.append(heading('What the agent filled in, and what it used'));
    var table = document.createElement('table');
    var head = document.createElement('tr');
    ['Step', 'Question on the form', 'Answer', 'Where it came from', 'Notes'].forEach(function (text) {
      var th = document.createElement('th'); th.textContent = text; head.append(th);
    });
    table.append(head);
    detail.fields.forEach(function (field) {
      var row = document.createElement('tr');
      var sourceWords = {
        verified_fact: 'A verified fact in your profile',
        application_scoped_answer: 'An answer you gave for this application',
        approved_document: 'Your approved CV',
        unresolved: 'Not answered — waiting for you',
        human_only: 'Only you may answer this',
        not_applicable: 'Not applicable'
      };
      var notes = [];
      if (field.sensitive) notes.push('sensitive question');
      if (field.unknown) notes.push('not recognised by the agent');
      if (field.required) notes.push('required by the form');
      if (field.evidenceFactIds.length) notes.push(field.evidenceFactIds.length + ' evidence reference(s)');
      if (field.validationStatus === 'rejected') notes.push('form rejected it: ' + (field.validationMessage || ''));
      [field.stepId, field.label, field.answerPreview === null ? '—' : field.answerPreview,
       sourceWords[field.source] || field.source, notes.join('; ')].forEach(function (text) {
        var td = document.createElement('td'); td.textContent = text; row.append(td);
      });
      table.append(row);
    });
    container.append(table);
  }

  function renderReview(container, detail) {
    container.append(heading('Review and approval'));
    var box = document.createElement('div');
    box.className = 'item';
    if (!detail.manifestHash) {
      box.textContent = 'There is no review to approve yet.';
      container.append(box);
      return;
    }
    var reference = document.createElement('div');
    reference.innerHTML = 'Review reference: <code>' + detail.manifestHash.slice(0, 12) + '</code>';
    var explain = document.createElement('div');
    explain.className = 'muted';
    explain.textContent = 'Approval is tied to exactly these answers, this CV and this form. If anything changes, the approval stops working and you will be asked again.';
    box.append(reference, explain);

    if (detail.approval) {
      var state = document.createElement('div');
      state.className = 'actions';
      state.append(pill('Approval: ' + detail.approval.decision + (detail.approval.consumed ? ' (used)' : ''),
        detail.approval.decision === 'approved' ? 'good' : 'bad'));
      box.append(state);
    }

    var actions = document.createElement('div');
    actions.className = 'actions';
    var approve = document.createElement('button');
    approve.type = 'button';
    approve.textContent = 'Approve these exact answers';
    approve.addEventListener('click', function () { decide(detail, 'approved', approve); });
    var reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'quiet';
    reject.textContent = 'Reject';
    reject.addEventListener('click', function () { decide(detail, 'rejected', reject); });
    actions.append(approve, reject);
    box.append(actions);
    container.append(box);
  }

  function decide(detail, decision, button) {
    button.disabled = true;
    request('/v1/applications/:userId/' + detail.application.applicationId + '/decision', {
      method: 'POST',
      body: JSON.stringify({ decision: decision, manifestHash: detail.manifestHash })
    }).then(function (body) {
      say(body.message);
      loadDetail(detail.application.applicationId);
    }).catch(function (error) { say(error.message, true); button.disabled = false; });
  }

  function renderOutcome(container, detail) {
    container.append(heading('Outcome'));
    var box = document.createElement('div');
    box.className = 'item';
    var pills = document.createElement('div');
    pills.append(pill('Stage: ' + (stageWords[detail.application.stage] || detail.application.stage),
      detail.application.stage === 'SUBMITTED' ? 'good' : ''));
    pills.append(pill('Submission record: ' + detail.submission.ledgerStatus));
    if (detail.submission.confirmationReference) {
      pills.append(pill('Fake reference ' + detail.submission.confirmationReference, 'good'));
    }
    box.append(pills);
    if (detail.application.stage === 'SUBMISSION_UNKNOWN') {
      var unclear = document.createElement('div');
      unclear.className = 'note error';
      unclear.textContent = 'The fake ATS did not say clearly what happened. Nothing will be tried again automatically; check the site yourself and then decide.';
      box.append(unclear);
    }
    var artifacts = document.createElement('div');
    artifacts.className = 'muted';
    artifacts.textContent = detail.artifacts.length
      ? detail.artifacts.length + ' redacted screenshot/trace file(s) were kept for debugging. They never contain your answers.'
      : 'No screenshots or traces were kept.';
    box.append(artifacts);
    container.append(box);
  }

  function renderControls(container, detail) {
    container.append(heading('Controls'));
    var actions = document.createElement('div');
    actions.className = 'actions';
    var takeover = document.createElement('button');
    takeover.type = 'button';
    takeover.className = 'quiet';
    takeover.textContent = 'I will take over';
    takeover.addEventListener('click', function () {
      takeover.disabled = true;
      request('/v1/applications/:userId/' + detail.application.applicationId + '/takeover', { method: 'POST', body: '{}' })
        .then(function (body) { say(body.message); loadDetail(detail.application.applicationId); })
        .catch(function (error) { say(error.message, true); takeover.disabled = false; });
    });
    var resume = document.createElement('button');
    resume.type = 'button';
    resume.className = 'ghost';
    resume.textContent = 'Resume';
    resume.addEventListener('click', function () {
      resume.disabled = true;
      request('/v1/applications/:userId/' + detail.application.applicationId + '/resume', { method: 'POST', body: '{}' })
        .then(function (body) { say(body.message); loadDetail(detail.application.applicationId); })
        .catch(function (error) { say(error.message, true); resume.disabled = false; });
    });
    actions.append(takeover, resume);
    container.append(actions);
  }

  function loadDetail(applicationId) {
    say('Loading that practice application…');
    request('/v1/applications/:userId/' + applicationId, {}).then(function (detail) {
      current = detail;
      var container = el('detail');
      container.hidden = false;
      container.replaceChildren();

      var warn = document.createElement('div');
      warn.className = 'warn';
      warn.textContent = 'Local fake ATS. No employer sees any of this, and automatic submitting is off.';
      container.append(warn);

      var title = document.createElement('h2');
      title.textContent = detail.job.title + ' — ' + detail.job.employer;
      container.append(title);
      var stage = document.createElement('div');
      stage.append(pill(stageWords[detail.application.stage] || detail.application.stage,
        detail.application.stage === 'SUBMITTED' ? 'good' : detail.application.pauseReason ? 'warn' : ''));
      if (detail.application.pauseReason) stage.append(pill('Paused: ' + detail.application.pauseReason.replace(/_/g, ' '), 'warn'));
      if (detail.application.takeoverRequested) stage.append(pill('You have taken over', 'warn'));
      stage.append(pill('Adapter ' + detail.application.adapterId + ' ' + detail.application.adapterVersion));
      container.append(stage);

      renderSteps(container, detail.steps);
      renderQuestions(container, detail);
      renderFields(container, detail);
      renderReview(container, detail);
      renderOutcome(container, detail);
      renderControls(container, detail);
      say('Loaded. Nothing here was sent to an employer.');
    }).catch(function (error) { say(error.message, true); });
  }

  el('load').addEventListener('click', loadList);
</script>
</body>
</html>`;
