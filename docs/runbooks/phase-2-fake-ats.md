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
   field could not be recognised at all. Answers given on this screen are always scoped to this
   application only; the screen offers no way to write one back to your profile.
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

## 4a. Doing it through the screens

The screens can display a practice application and let you answer, confirm, approve, reject and
resume — but nothing in `apps/api` starts or advances one. `ApplicationRunner` is not wired into the
service. `scripts/phase-2-screen-walkthrough.mjs` supplies that drive, against a throwaway database
so your real profile, CV and tracker are never opened.

It refuses to run unless `WALKTHROUGH_DATA_DIR` is set to something other than the real
`./local-data/pglite`, and refuses any `FAKE_ATS_ORIGIN` that is not a loopback address.

PGlite is single-writer, so the agent must be stopped while a stage runs and started again to use
the screens. Run each stage as:

```bash
# stop pnpm api first
WALKTHROUGH_DATA_DIR=./local-data/phase2-screens/pglite \
  node --env-file=.env scripts/phase-2-screen-walkthrough.mjs <stage>
```

Then start the agent against the same throwaway database, and open `/applications`:

```bash
PGLITE_DATA_DIR=./local-data/phase2-screens/pglite \
ARTIFACT_DATA_DIR=./local-data/phase2-screens/artifacts pnpm api
```

| Stage       | What it does, and what you do next on the screen                                    |
| ----------- | ----------------------------------------------------------------------------------- |
| `seed`      | Creates the throwaway database and stops with the unknown fields open. Answer them. |
| `advance`   | Carries on, and stops on the step only a person may do.                             |
| `resume`    | Resumes, once you have completed and confirmed each human-only question.            |
| `review`    | Builds the review. Read it on the screen and approve it.                            |
| `stale`     | The form gains a required field, so your approval no longer matches. Re-approve.    |
| `submit`    | Makes the one practice submission, then proves a second is refused.                 |
| `status`    | Prints where the application currently is.                                          |
| `ambiguous` | Switches the fake site to return no confirmation, for a reconciliation run.         |

The `seed` stage prints the synthetic profile ID to paste into the screen. Your admin token comes
from `.env` as usual — copy it from the file, never into a chat.

On the human-only step the screen shows no answer box. For each one: choose **I will take over**,
complete the page yourself at the address the `advance` stage prints, then choose **I completed this
myself**. That confirmation stores no value, so the agent never learns what you entered. It refuses
before takeover is active, and the run refuses to resume until every one is confirmed.

Do not run `advance` again after resuming. The human-only step is done, and re-planning it would
simply re-open those questions. The script refuses, and points you at `review`.

When you have finished, delete the throwaway database and restart the agent with your normal
settings:

```bash
rm -rf ./local-data/phase2-screens
pnpm api
```

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
Date:                      2026-09-26
Driven by:                 scripts/phase-2-screen-walkthrough.mjs against the throwaway database
                           ./local-data/phase2-screens, the bundled fake ATS on 127.0.0.1:3311, and
                           an invented applicant. No real profile, CV, vacancy or employer involved.

Practice application completed end to end:            yes   FAKE-ATS-B45BD416
Unknown field paused and was answered by me:          yes   favourite_colour and referral_code both
                                                            paused as unknown_field; answered Blue
                                                            and None, application-scope only
Sensitive question was never answered by the agent:   yes   disability, criminal_record, ethnicity
                                                            all held as human_action; the review
                                                            records them as "you completed this
                                                            yourself; the agent never saw it" and
                                                            carries no preview or hash for them
Approval was invalidated after a material change:     yes   approved 844f7689ebbea673; the form then
                                                            gained a required field, the review
                                                            became c93e8c9ed3fd85c7, and the submit
                                                            was refused snapshot_changed
Exactly one fake confirmation reference was issued:   yes   FAKE-ATS-B45BD416; a second submission
                                                            refused state_not_ready; the fake site
                                                            recorded submitCount 1
Ambiguous outcome went to reconciliation, no retry:   yes   evidenced by pnpm walkthrough:phase2
                                                            step 9: SUBMISSION_UNKNOWN, ledger
                                                            unknown, refused state_not_ready
Manual takeover and resume worked:                    yes   but only after the defect below was
                                                            fixed; see "Defects found"
Test command and count:   pnpm check — 315 tests passing, 34 files, none skipped
Migration version:        0005_advert_attachment_criteria.sql
Commit at sign-off:       f6900ac plus the two commits recorded below

Defects found and fixed during this walkthrough
  1. No screen or route could start or advance a practice application. ApplicationRunner was never
     wired into apps/api, and the applications page told the user "a practice run is started from
     the tracker page" when the tracker had no such control. Closed by adding
     scripts/phase-2-screen-walkthrough.mjs, which supplies that drive without adding any
     production route. The page text has been corrected.
  2. A run that paused on a sensitive or human-only step could never be resumed through the
     screens. Such questions are opened with responseKind 'human_action'; the answer route refuses
     those by design, resume() refuses while any question is open, and no route could close one.
     The screens deadlocked in WAITING_TAKEOVER permanently. Fixed by adding
     POST /v1/applications/:userId/:applicationId/questions/:questionId/completed and an
     "I completed this myself" control. It stores no value, requires takeover to be active first,
     and is idempotent. Covered by 7 new tests at both the workflow and route layers.
     The automated suite had not caught this because pnpm walkthrough:phase2 writes directly to the
     store, bypassing the route guard that was missing.

Limits of this sign-off — read before treating Phase 2 as complete
  - Screens 1 and 2 were observed by the user directly. The remaining stages were driven by the
    script above rather than watched screen by screen, at the user's instruction. The mechanism is
    evidenced; the "does it read clearly to a nontechnical user" judgement that section 4 asks for
    is therefore only partly done.
  - The steps that only a person may do were completed by a headless browser standing in for the
    user, not by the user in their own browser. What that proves is that the agent never touches
    them, which is the safety property. It does not prove the human experience of doing them.
  - The ambiguous-outcome case was evidenced from the automated walkthrough, not from the screens.
  - MVP acceptance criterion 14 in the architecture — a prompt-injection corpus cannot alter
    policy, expose unrelated facts, escape the allowlist or cause submission — has no corpus and no
    test anywhere in this repository. That criterion is unproven and Phase 2 should not be called
    an MVP completion gate until it is.

Still no browser automation outside the bundled fake ATS, and no real submission: confirmed
Approved to begin Phase 3: no
```

Phase 3 — a single real, supervised employer adapter — must not be started until this block is
filled in and you explicitly ask for it.
