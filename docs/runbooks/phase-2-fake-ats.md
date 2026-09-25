# Phase 2 runbook — practice applications on the local fake ATS

Everything in this runbook happens on your own machine, against a fake job site that ships with
this repository. No employer, no real vacancy site and no candidate account is involved at any
point, and there is no setting in this phase that would change that.

Read this once before you start. Each section tells you what to do and what you should see.

---

## 1. What this phase does, in plain words

The agent can now open a web browser, read a practice application form, and fill in only the
answers your approved profile actually supports. Anything it cannot support — an unknown question,
a sensitive question, a CAPTCHA, a declaration, a consent tick, an assessment — it stops and asks
you. Nothing is ever sent until you have read the exact answers on screen and approved them, and
even then only one practice submission can happen.

What it cannot do, by construction:

- It cannot open MyJobScotland's application pages, or any other real employer form. The browser
  worker refuses any address that is not on your own computer, and refuses it again at the network
  layer.
- It cannot use your saved logins, cookies or browser profile. It starts a clean, empty browser
  every time and throws it away afterwards.
- It cannot answer a CAPTCHA, a one-time code, an assessment, a declaration or a consent question.
  Those stop the run and wait for you.
- It cannot submit anything automatically. Auto-submit is off and cannot be switched on here.

---

## 2. One-time setup

If you would rather not type anything, double-click `scripts\windows-run-phase2.cmd`. It does the
whole of sections 2 and 4 in one go and writes a transcript to `phase-2-run.log` in this folder.

Otherwise:

```bash
pnpm install --package-import-method=copy
pnpm browser:install   # downloads the Chromium the browser worker uses
pnpm db:migrate
```

`pnpm browser:install` is needed once per machine. Without it the browser tests skip themselves and
practice runs cannot start; everything else still works.

---

## 3. Start the fake ATS and the agent

Two terminals.

```bash
# terminal 1 — the practice job site
pnpm fake-ats
```

```bash
# terminal 2 — the agent
pnpm api
```

The fake site listens on `http://127.0.0.1:3311` and the agent on `http://127.0.0.1:3210`. Both
refuse to bind to anything other than your own machine. If you change `FAKE_ATS_PORT`, set
`FAKE_ATS_ORIGIN` in `.env` to match; a non-loopback value makes the agent refuse to start.

Open `http://127.0.0.1:3210/applications`.

---

## 4. Walk one practice application end to end

`pnpm walkthrough:phase2` drives the whole thing automatically and narrates each step, including
the two rehearsals in section 5. `docs/phase-2-walkthrough-record.md` holds a transcript of a
previous run so you can see what to expect. Doing it by hand through the screens, as below, is what
the sign-off is really about: the transcript proves the mechanism, your walkthrough judges whether
it reads clearly.

1. **Start it.** From the applications page, start a practice run for a shortlisted role. The stage
   line at the top tells you where it is at every moment.
2. **Watch it stop.** The fake form deliberately contains questions your profile cannot answer: an
   invented "favourite colour" field, a question about a visa that only appears if you answer the
   one before it in a certain way, and an equal-opportunities section. The run pauses and lists
   them under "Questions that need you".
3. **Answer one.** Each question says why you are being asked — no verified fact, the fact is out of
   date, the fact is not allowed to be used for applications, the question is sensitive, or the
   field could not be recognised at all. Answer it, and choose whether that answer is for this
   application only (the default) or should be saved to your profile.
4. **Leave a sensitive one alone.** The equal-opportunities questions are marked human-only. The
   agent will not answer them, and there is no setting that makes it.
5. **Read the review.** When nothing is outstanding, open the review. It lists every field, the
   evidence behind each answer, which CV version would be attached, and a reference that stands for
   that exact set of answers.
6. **Approve.** Approval is bound to that reference. Change any answer afterwards and the approval
   stops being valid — you will be asked to look again. That is the intended behaviour, not a fault.
7. **Submit once.** The practice submission runs and you get a fake confirmation reference of the
   form `FAKE-ATS-XXXXXXXX`. Press anything twice, restart the agent mid-way, or replay the
   approval: you still get exactly one submission.

---

## 5. Things worth trying deliberately

The fake site has a control endpoint so you can rehearse the awkward cases:

```bash
# make the first attempt at a step fail validation
curl -X POST http://127.0.0.1:3311/__control -H 'content-type: application/json' \
  -d '{"validationOnFirstAttempt": true}'

# make the submission outcome unclear
curl -X POST http://127.0.0.1:3311/__control -H 'content-type: application/json' \
  -d '{"submitOutcome": "ambiguous"}'

# slow every page down
curl -X POST http://127.0.0.1:3311/__control -H 'content-type: application/json' \
  -d '{"delayMs": 1500}'

# reset
curl -X POST http://127.0.0.1:3311/__control -H 'content-type: application/json' -d '{}'
```

What you should see:

- **Validation errors**: the agent re-reads the page, corrects what it can from evidence, and after
  three rounds stops and asks you rather than looping.
- **Ambiguous outcome**: the application moves to reconciliation and waits. It never retries a
  submission by itself, because a retry could produce a second application.
- **Manual takeover**: choose "Take over" at any point. The agent stops immediately. Finish the step
  yourself in the browser and choose "Resume"; it will refuse to resume while a question is still
  open, and will refuse to carry on from a checkpoint if the form has changed underneath it.

---

## 6. Discord, if you have configured it

The same actions are available in Discord once its secrets are in your local `.env`:

- `/application list` — practice applications in progress.
- `/application show id:1a2b3c4d` — stage, questions outstanding, review reference, approval state.
- `/application question id:1a2b3c4d` — the question the agent is waiting on, and why.
- `/application answer id:1a2b3c4d value:Blue` — answers it for that application only.
- `/application approve id:1a2b3c4d manifest:9f2c1ab4d0e1` — approval bound to that review.
- `/application reject id:1a2b3c4d reason:...` — records a rejection.
- `/application takeover id:1a2b3c4d` / `/application resume id:1a2b3c4d`.

Commands from any other Discord account are refused, and sending the same command twice is
harmless: the second one reports that it was already handled and changes nothing.

Never paste a token into a chat with anyone, including an assistant. Discord secrets belong only in
your local `.env`.

---

## 7. What the agent keeps, and what it does not

It keeps: which field was asked, what kind of control it was, which fact was used as evidence, a
hash of each answer, a hash of the approved CV, screenshots with every input masked, and a trace of
the browser run.

It does not keep, anywhere, and does not send to any model: your `.env` values, your decrypted
profile facts, your CV text, browser cookies or storage, or the text of the pages the browser
visited. The worker runs as its own process and returns only a sanitised report; applicant values
go in and do not come back out.

---

## 8. Phase 2 sign-off

Fill this in once you have done section 4 and at least two cases from section 5, then paste it under
the status table in `CLAUDE.md`.

```text
Phase 2 sign-off
Date:
Practice application completed end to end:            yes / no
Unknown field paused and was answered by me:          yes / no
Sensitive question was never answered by the agent:   yes / no
Approval was invalidated after I changed an answer:   yes / no
Exactly one fake confirmation reference was issued:   yes / no
Ambiguous outcome went to reconciliation, no retry:   yes / no
Manual takeover and resume worked:                    yes / no
Test command and count:   pnpm check —        tests
Notes:
```

Phase 3 — a single real, supervised employer adapter — must not be started until this block is
filled in and you explicitly ask for it.
