# Job Application Agent

Standalone, policy-driven job discovery and application orchestration. This repository is deliberately separate from MapVantage.

## Current milestone

Phase 2: a browser framework that practises applications against a **local fake ATS that ships with
this repository**. Real application automation and production submission remain disabled, and there
is no setting in this phase that enables them.

Phase 2 adds:

- a local fake applicant tracking system with multi-page forms, text/email/telephone/number inputs,
  textareas, selects, radios, checkboxes, repeatable employment and education sections, a CV upload,
  required-field and format validation, conditional fields, sensitive questions, deliberately
  unrecognisable fields, simulated CAPTCHA/one-time-code/assessment/declaration/consent steps, a
  fake final submission with a confirmation reference, and switches for failures, delays and
  ambiguous outcomes;
- a Playwright browser worker in its own process, with a fresh empty browser context per attempt,
  no imported cookies or storage state, no persistent profile, and a network rule that aborts any
  request outside the loopback address;
- a typed browser-action DSL whose every action is checked by deterministic code against the
  workflow state, the adapter contract, the reviewed field inventory, the applicant fact use policy,
  the site policy, the human-only rules and the submit guard before it can run;
- deterministic field mapping, and answers resolved only from verified facts that permit
  application use or from an answer you gave for that application;
- a rule that the agent never invents an answer: unknown, ambiguous, sensitive, expired, unverified
  and use-forbidden information all pause the run and ask you;
- durable application sessions with step-level checkpoints, pause and resume, crash recovery,
  manual takeover, validation-error handling, approved-CV upload, redacted screenshots and traces,
  and a review manifest binding the job, the answers, the evidence, the CV hash and the adapter
  version;
- Discord commands for viewing a paused question, answering it for that application, approving or
  rejecting the exact review, requesting manual takeover and resuming;
- a submit guard that permits at most one fake submission: approval is bound to the exact review
  hash, any material change invalidates it, approval is single use, and a restart before or after
  the submission cannot produce a second one;
- a local `/applications` screen in plain language showing the stage, completed and paused steps,
  questions that need you, the evidence behind each answer, sensitive and unrecognised fields, the
  review, approval state, the fake confirmation reference, and takeover/resume controls.

Phase 1B foundation:

- versioned, reviewed source configuration that is disabled by default, with a 15 minute minimum
  polling interval and a documented-feed adapter that never guesses an endpoint;
- durable normalised vacancies, immutable source snapshots, canonical deduplication by URL and by
  employer/title/location/closing-date fingerprint, and idempotent reruns keyed on the schedule slot;
- lifecycle tracking for open, changed, closed, expired and duplicate adverts, and review tracking
  for discovered, shortlisted, reviewed, rejected and archived roles;
- match decisions that are reproducible from the recorded job version, profile snapshot, matcher
  version and configuration version, with evidence references rather than copied applicant data;
- a local tracker page with filters for status, score, employer, location, salary, date and source,
  where adding a vacancy link reads the advert, scores it and shows the decision in one step;
- source switch-on that fails closed unless a reviewed, current site policy permits that source's
  discovery action and a purpose-written reader exists for the domain;
- a scheduler that refuses to do any work until the profile ID, the profile itself and every
  switched-on source are valid, and reports exactly what is wrong instead of failing repeatedly;
- a transactional outbox with deduplicated Discord delivery, bounded retries, dead-letter
  visibility, quiet hours and a global kill switch;
- signed, allowlisted, replay-safe Discord commands that can only change your own tracker.

Phase 1A foundation:

- versioned domain and policy types;
- Applicant Knowledge Base validation, completeness checks, and evidence-grounding enforcement;
- authenticated, local-only onboarding API with encrypted profile and quarantined CV persistence;
- HTTPS-only job URL canonicalisation and deterministic duplicate fingerprints;
- read-only MyJobScotland public-advert extraction and deterministic shadow matching;
- authenticated-portal policy definitions, including a safe myjobscotland/TalentLink baseline;
- deterministic salary, prerequisite, score, and action decisions;
- application state-machine invariants;
- embedded PostgreSQL-compatible local storage, with an optional full PostgreSQL deployment;
- baseline schema and transactional outbox tables;
- synthetic demonstration and automated tests.

Browser automation in this milestone runs **only against the bundled fake ATS**. There is no real
job submission capability, and auto-submit remains disabled.

MyJobScotland public-advert discovery is available, but real-site prefill and submission are disabled: the permission review was redone on 2026-09-28 and the blocker stands. What you get instead is [`/application-prep`](docs/runbooks/application-preparation.md), a per-job pack of grounded answers to copy into the employer's own form. No portal password is persisted. The local `/profile-history` page lets the applicant confirm structured rows drafted from an already-reviewed CV. The local `/answer-vault` page stores optional reusable answers encrypted in the profile; it does not yet fill them into any employer form. Vault values are excluded from matching and automatic form answers, are never sent to Discord, and can be removed through that page.

On `/tracker`, **Find jobs now** runs the reviewed, read-only Adzuna search when that source is enabled. It looks for customer service, administration, insurance, fraud, compliance and financial services around Glasgow, plus remote customer-service and admin leads across the UK. The source's per-run result cap is spread across these eight searches; it is not eight times larger. Manual runs have a one-hour cooldown. Results are excerpt-only leads, not confirmed matches or applications. The button uses the same site-policy and duplicate-run gates as scheduled searching.

For an excerpt-only lead, **Compare a full advert I copied** lets the applicant paste the complete advert and optional separate person specification for a tentative, read-only comparison. The text and result are not saved; the tracker lead stays an excerpt, cannot gain an application action from this comparison, and no unreviewed employer site is contacted. Use the reviewed official-advert URL path when one is available instead.

## Requirements

- Node.js 22–25
- pnpm 10+
- Docker only for the optional full PostgreSQL deployment

## Start

```bash
pnpm install
pnpm check
pnpm demo
```

The demo uses synthetic applicant and job data. Do not put real secrets or applicant data in the repository.

## Local encrypted onboarding service

The onboarding service includes a local browser form for preferences, core applicant facts, employment and education history, skills, and an optional CV. The default setup uses an embedded PostgreSQL-compatible database, so it does not require Docker, WSL, administrator access, or a separate database installation.

1. Run `pnpm setup:local` once. This creates the ignored `.env` file and local data directory without displaying the generated secrets.
2. Run `pnpm db:migrate`.
3. Run `pnpm api`.
4. Open `http://127.0.0.1:3210/onboarding` in a browser.

On this Windows PC, the per-user `JobApplicationAgent` scheduled task starts the built local API at
sign-in using `scripts/run-local-agent.ps1`. It reads secrets from the ignored `.env` file; no
token is stored in the task command. The PC must be on, the user signed in, and the network
available for scheduled discovery and Discord delivery. The task does not build code or enable
real-employer form filling/submission. If the project moves or is rebuilt on another PC, update
the task's script path before relying on it. Check the local `/health` page and Task Scheduler's
`JobApplicationAgent` status if the tracker is unavailable.

For running discovery and outbound Discord notifications while this PC is off, a restricted
container package is prepared in [`docs/runbooks/always-on-discovery.md`](docs/runbooks/always-on-discovery.md).
It is not deployed yet; the shortlist-quality sign-off, host choice, encrypted data transfer,
backup, and single-writer cutover are still required. Hosted mode does not enable real applications.

The form requires the local `PROFILE_ADMIN_TOKEN` from `.env`. Treat it like a password: do not paste it into chat, commit it, or send it to another person. It is kept only in the open page's memory and is not placed in browser storage.

For a production-like deployment, set `DB_MODE=postgres`, provide `DATABASE_URL`, start PostgreSQL (for example with the included Docker Compose file), and run the same migration command. The embedded mode is intended for the single-user, cost-conscious MVP.

The service listens only on the loopback interface in this phase. All profile routes require the `PROFILE_ADMIN_TOKEN`. Profile values are encrypted before database storage using AES-256-GCM and record-specific authenticated data; metadata is stored separately for policy decisions.

Available routes:

- `GET /health` — no applicant data and no authentication required.
- `GET /onboarding` — local, non-technical preference form; no-store response and no browser token persistence.
- `GET /cv-review` — local CV extraction, correction, and explicit approval screen.
- `GET /shadow-match` — local screen for checking one public MyJobScotland vacancy against an approved profile.
- `GET /tracker` — local shortlist and tracker, with filters and review actions.
- `GET /applications` — local practice-application screen for the fake ATS: stage, steps, questions
  that need you, evidence behind each answer, the review, approval, and takeover/resume.
- `GET /v1/onboarding/requirements` — staged data requirements.
- `POST /v1/profile/users` — creates the local applicant profile.
- `POST /v1/profile/facts` — stores one explicitly confirmed, versioned fact.
- `POST /v1/profile/documents/cv` — encrypts a PDF/DOCX CV and places it in quarantine pending safety scan and approval.
- `POST /v1/profile/documents/cv/process` — verifies the encrypted artifact, runs conservative structural checks and Microsoft Defender locally, then extracts reviewable text.
- `POST /v1/profile/documents/cv/approve` — binds explicit approval to the exact document hash and stores the reviewed sections as evidence.
- `GET /v1/profile/:userId/facts` — authenticated local review.
- `GET /v1/profile/:userId/readiness` — reports missing categories without exposing them in logs.
- `POST /v1/shadow-match/myjobscotland` — fetches one allowlisted public advert and returns a read-only match result; it cannot access a candidate account or application form.
- `GET /v1/tracker/:userId/jobs` — filtered shortlist: status, advert state, score, employer, location, salary, salary certainty, discovery date, closing date, source and free text.
- `GET /v1/tracker/:userId/jobs/:jobId` — one job with its stored decision, reasons and history.
- `POST /v1/tracker/:userId/jobs/:jobId/status` — records an explicit review decision.
- `POST /v1/tracker/:userId/jobs/:jobId/pasted-advert-review` — transient comparison of applicant-supplied full advert text, with no employer-site fetch or change to the tracked lead.
- `GET|POST /v1/sources`, `POST /v1/sources/:key/enabled`, `PUT /v1/sources/:key/urls` — reviewed source configuration. Switching a source on returns `409` with a plain-language reason when the site policy is missing, expired, prohibited or does not cover that discovery action, or when no reviewed reader exists for the domain.
- `POST /v1/discovery/runs` — an on-demand run of one reviewed source.
- `POST /v1/discovery/manual-url` — saves one public MyJobScotland vacancy link, reads the advert and returns its match decision in the same request.
- `POST /v1/match/run` — scores anything new against verified profile facts.
- `GET /v1/agent/status`, `POST /v1/agent/pause`, `POST /v1/agent/resume` — health, per-source state, scheduler readiness problems and the kill switch.
- `POST /v1/discord/interactions` — signature-verified Discord commands; disabled unless Discord secrets are configured.
- `GET /v1/applications/:userId` and `GET /v1/applications/:userId/:applicationId` — practice
  applications on the fake ATS, their stage, questions and evidence references.
- `POST /v1/applications/:userId/:applicationId/questions/:questionId/answer` — records one answer
  for that application; an identical resend is reported as already recorded and changes nothing.
- `POST /v1/applications/:userId/:applicationId/review` — builds the review manifest and its hash.
- `POST /v1/applications/:userId/:applicationId/decision` — approval or rejection bound to that
  exact hash; a stale hash returns `409`.
- `POST /v1/applications/:userId/:applicationId/takeover` and `.../resume` — manual takeover and
  resume.

CV uploads are restricted to PDF/DOCX files of at most 5 MB, checked for a matching file signature, encrypted before local storage, and marked `pending`. Processing verifies the SHA-256 digest, rejects active/embedded content and unsafe DOCX expansion, scans a short-lived decrypted copy with Microsoft Defender using remediation disabled, and then extracts text locally. The temporary copy is deleted immediately. A CV is not counted as evidence until the user approves the exact scanned version and hash. The API has no job-site browser automation or submission capability.

The shadow matcher reads only verified facts that permit matching. It treats unmatched mandatory wording as unknown, never invents evidence, applies the configured GBP 25,000 salary floor, and always disables application actions. The first discovery slice accepts a single public vacancy URL; scheduled feed discovery and authenticated assisted prefill are later phases.

## Scheduled discovery and notifications

Nothing polls the network until you enable it. See
[`docs/runbooks/phase-1b-discovery.md`](docs/runbooks/phase-1b-discovery.md) for turning scheduled
discovery on, adding a reviewed source, pausing everything, configuring Discord, and reading the
failure surface. `pnpm shadow:corpus` prints the deterministic decision for a synthetic review
corpus so shortlist quality can be judged before any later phase.

## Practice applications on the fake ATS

See [`docs/runbooks/phase-2-fake-ats.md`](docs/runbooks/phase-2-fake-ats.md). In short:
`pnpm browser:install` once per machine, then `pnpm fake-ats` in one terminal and `pnpm api` in
another, and open `http://127.0.0.1:3210/applications`. The fake site binds to `127.0.0.1:3311` and
the agent refuses to start if `FAKE_ATS_ORIGIN` is not a loopback address.

## Preparing one application

The agent cannot fill a real employer form, so it prepares one for you to fill.

See [`docs/runbooks/application-preparation.md`](docs/runbooks/application-preparation.md). In
short: on `/tracker`, choose **Prepare application** on a shortlisted job, then **Open the full
answer pack**. `/application-prep` shows every question the form asks, in form order, in one of
three states — ready to copy, you answer this, or yours only — with the source of each ready answer
and a copy button per answer plus one for the lot.

One-time setup that pays off here: `/profile-history` confirms your employment and education rows,
and `/leaving-reasons` links each recorded reason for leaving to the role it belongs to. The join
between a reason and a role is exact by design — a reason must never be attached to an employer it
does not name — and CV-drafted rows often carry a town or work pattern the reason does not, so that
one screen turns those boxes from "you answer this" into ready-to-copy. It proposes a pairing only
where it is unambiguous in both directions, and never alters your wording.

Every value is verbatim from a verified profile fact or is the name of your approved CV. Nothing is
composed, inferred or reworded, the pack opens exactly as many role and qualification rows as your
profile records, and a detail the profile does not hold becomes a question rather than a guess.
Right to work, disclosure, equality monitoring, declarations, consent, login and CAPTCHA are never
answered for you. Reusable and demographic answers are shown only for the topics you tick on that
request, and never reach the copy-all. A job that is closed, restricted to internal candidates, or
already recorded as submitted produces no answers at all.

## What the tracker leads with

Not a score. `/tracker` groups vacancies by how much of the advert the agent could actually check
against your profile:

| Group                        | What it means                                                              |
| ---------------------------- | -------------------------------------------------------------------------- |
| Checked against your profile | Every requirement the advert states was judged either way.                 |
| Partly checked               | Some judged, some not.                                                     |
| Yours to judge               | Requirements were read and none could be judged. The agent has no opinion. |
| Requirements never read      | Nothing was established at all. Open the advert.                           |
| Blocked                      | A hard gate failed, such as a vacancy open only to existing staff.         |

The score is still recorded and still shown, but as a secondary pill. It stopped being the headline
because it did not separate anything: measured across ten real adverts it sat inside a 17-point band,
and every rejection was a hard gate rather than a score. None of the group boundaries is a tunable
number — each is decided by whether a count is zero — so there is nothing here to tune.

`pnpm shortlist:report` prints the same grouping for your own tracked jobs. If it says almost nothing
has been checked, re-score first: a tracker row shows the decision of whichever matcher last scored
it, and that can predate the criteria-reading work. Choose **Score anything new** on `/tracker`.

## Applying by email

For vacancies whose advert **explicitly instructs candidates to apply by email**, approving in
Discord really does send the application. Nothing else in this project does that.

Setting it up is `pnpm email:setup`: a guided, resumable walkthrough that opens each Google page you
need, names the button, and writes the result to your `.env`. See
[`docs/runbooks/email-applications.md`](docs/runbooks/email-applications.md) for the detail, including
the one recurring chore — while the Google app is in Testing status, the authorisation expires every
7 days and `pnpm email:authorise` renews it in twenty seconds. In short: `/apply prepare id:<job>` reads the advert's own instruction,
builds a message from verified profile facts only, and posts it to your private channel in full —
recipient, reply address, subject, attachment name and hash, the advert's instruction quoted word for
word, and the entire body as it would be sent. `/apply approve id:<job> manifest:<reference>` sends
it, once.

The approval is bound to a hash of everything that could change what the employer receives: a word of
the body, the recipient, the attached CV, the advert version behind it. Change any of them and the
earlier approval no longer matches and the send is refused as stale. A send the provider does not
confirm is never retried — it waits for you to check your sent mail and say what happened.

It is off until an email provider is configured, refused entirely in the hosted discovery-only
deployment, and cannot be used for a vacancy that asks for an online application.

## Safety defaults

- Minimum annual base salary: GBP 25,000.
- Auto-candidate threshold: 85/100.
- Auto-submit is disabled.
- Browser automation is restricted to the bundled fake ATS. The worker refuses a non-loopback
  target, aborts any non-loopback request, imports no cookies or storage state, and copies no
  browser profile.
- CAPTCHA, one-time codes, assessments, declarations and consent are never answered by the agent.
- No route can open, fill or submit a real employer form. The per-job answer pack reads the profile
  through the same gates a real prefill would have to pass and prints what they allow, for you to
  copy; it contacts no employer and records no submission.
- The one outward-facing action is sending an email application, and only for a vacancy whose advert
  instructs it. The recipient comes from the advert's own published instruction and nowhere else, the
  message is built solely from verified facts and contains no claim about you, approval is single-use
  and bound to a hash of everything that could change what is received, and a send the provider does
  not confirm pauses for you rather than being retried.
- A demographic or reusable answer is returned only for a topic named on that one request, is never
  included in a copy-all, and is never auto-filled anywhere.
- At most one fake submission can occur per application, and approval is invalidated by any
  material change to the answers or the CV.
- Unknown mandatory prerequisites and ambiguous salary block automatic progression.
- A criteria document linked from a public advert is read only when the reviewed site policy carries
  an explicit permission for it, only from the reviewed domain over HTTPS, and only when the advert
  page itself published the link. It is inspected for active content, scanned with Microsoft
  Defender, and extracted locally before any requirement is derived from it. A document that cannot
  be read safely is recorded as unreadable, blocks anything automatic, and keeps the role visible for
  review rather than being scored as though the advert had no requirements.
- New domains are disabled until a reviewed site policy allows them, and a domain with no
  purpose-written public parser cannot be configured as a source at all.
- Scheduled polling is off by default, never faster than every 15 minutes, and obeys the reviewed
  rate limit. It stays idle, with a readable reason, while the profile ID, the profile or a
  switched-on source is invalid.
- Discord is inert until its secrets are set; commands are signature-verified, allowlisted to one
  user, replay-safe, and cannot start an application.
- External content is untrusted data and cannot alter policy.

See [`docs/architecture/JOB_APPLICATION_AGENT_ARCHITECTURE.md`](docs/architecture/JOB_APPLICATION_AGENT_ARCHITECTURE.md) for the complete approved specification. It is held in the repository so a clone carries it, byte-identical to the reviewed original.
