# Real application preparation and adapter pilot

The tracker now offers **Prepare application**. It reads the current tracked job and match evidence,
shows eligibility concerns and uncertain requirements, checks the closing date and advert status,
and offers **Open application site**. It creates no attempt and makes no submission claim.

Real browser prefill remains **disabled**. A separate reviewed real-site adapter now exists and is
tested against synthetic fixtures, but it ships switched off and the site policy does not permit
prefill; see "The real-site adapter" below. The fake-ATS start endpoint must never be used as its
replacement.

## Preparation and submitted-job protection

Migration 0006 adds a separate user-reported external submission ledger. It does not fabricate an
agent attempt or claim a provider-verified receipt. Authenticated users can record a tracked job
with its reference and timestamp through `POST /v1/applications/:userId/external-submission`.
Repeated calls preserve the first record. Preparation and new workflow attempts block a recorded
job. Existing in-flight attempts are not cancelled by this endpoint; do not record a job while a
worker is active on it. Cross-source protection depends on canonical discovery deduplication.

`GET /v1/applications/:userId/preparation/:jobId` supplies only verified, unexpired, auto-fill
profile facts allowed for application use, from an explicit category allowlist. It does not return
high-risk facts, credentials, documents, or facts for closed/already-submitted jobs. The tracker
shows these locally for review and offers a manual submission record control. It still does not
fill real websites or submit. The next milestone is a separate reviewed real-site adapter with
fixtures, safe field mapping and manual final submission—not enabling the existing fake adapter
against a real site.

## MyJobScotland review, 26 September 2026

Public sources reviewed:

- https://myjobscotland.gov.uk/faqs
- https://myjobscotland.gov.uk/privacy-and-cookies
- https://myjobscotland.gov.uk/disclaimer
- https://myjobscotland.gov.uk/terms-conditions

The FAQ describes candidate login/registration and multi-page applications with previously stored
employment and qualification information. The privacy page identifies TalentLink and describes CV
upload processing. The disclaimer says applications may redirect to organisation minisites.
The terms page does not provide usable permission for browser automation in its available text.
Consequently real automated prefill is not enabled by this review.

## The real-site adapter, 26 September 2026

A MyJobScotland/TalentLink adapter now exists. **Live prefill is disabled**, and the blocker below
is the reason. Everything described here is exercised against synthetic fixtures only; nothing in
this repository has connected to a real employer site.

### The blocker, exactly

The site-policy review recorded above found no usable permission for browser automation in
MyJobScotland's published terms. That has not changed. Concretely:

- The terms and conditions page does not grant, and does not describe, automated interaction with
  the candidate application flow.
- The application itself is served by Lumesse TalentLink, whose own terms were not part of that
  review and are not reachable without an authenticated candidate session.
- The disclaimer warns that some councils redirect to their own minisite, so the domain a given
  advert ends on is not fixed and cannot be reviewed in advance as a class.

So `myJobScotlandAdapter()` ships with `executionMode: 'disabled'`, and the preparation route
passes `sitePolicyPermitsPrefill: false` unconditionally. Two independent gates, either of which
alone stops execution. Switching prefill on requires a fresh documented permission review plus an
explicit user decision — it is not a configuration change.

### What was built

`RealSiteAdapter` in `@job-agent/browser-core` is a **separate contract** from `AdapterContract`,
not an extension of it. The fake contract fixes `allowsSubmit: true` and `isFakeTarget: true`; the
real one fixes both to `false`. A real target therefore cannot be passed where a fake one is
expected, and the fake adapter cannot be pointed at a production host. The loopback rule in the
existing validator and submit guard is untouched.

`validateRealSiteAction` is a separate validator for this path. It refuses `submit` unconditionally
— at every execution mode, under every policy, on every step — so there is no configuration in
which this path can send an application. It also fails closed on an unknown step, an unmapped
field, a human-only step or field, a non-HTTPS or off-allowlist destination, a next-control that is
not the recorded one, and any action taken before the user confirms they have signed in.

`resolveRealSiteAnswer` grounds answers in the profile's real structure (`identity.legal_name`,
`employment.history`, `education.history`, `work_authorisation.gb`) rather than the flat synthetic
keys the fake-ATS resolver uses. It will not:

- fill a role the profile does not hold, including a second or third employment row;
- attach a reason for leaving to an employer that reason does not name — the join is on the
  `employer` field recorded inside the reason itself, never on a key guessed from the row;
- answer right-to-work when any restriction or sponsorship flag is set;
- write a supporting statement. There is no such fact in the profile and the agent will not compose
  one, because a supporting statement is an argument about the applicant's suitability.

Equality monitoring, disclosure, disability and declaration questions are human-only both by step
and by field intent, so a page that moves such a question onto a fillable step is still refused.

### Internal-only eligibility

"Business Support Officer (QA)" was shortlisted despite being restricted to current Jobs and
Business Glasgow employees and ILM participants. The restriction had been extracted as an ordinary
requirement sentence, and requirement sentences are scored by evidence overlap, so generic words
made it look satisfied.

`detectInternalOnlyRestriction` now reads the advert and any criteria document and returns
`open`, `restricted` or `unclear`. `restricted` is a **hard reject**
(`restricted_to_internal_candidates`); `unclear` blocks automatic progression. The detected
sentences are removed from requirement extraction, so they can no longer be scored as met by
overlap. An advert that says both "open to internal and external" and "internal applicants only"
is `unclear`, not open. `internal-only.test.ts` pins the original advert, including a profile
deliberately stuffed with matching words.

### Preparation status

`preparationView` decides what the tracker's Prepare application control shows, in a fixed order so
a duplicate can never be presented as ready: `already_submitted`, `blocked_closed`,
`blocked_ineligible`, `unavailable`, `awaiting_login`, `preparing`, `needs_user_input`,
`ready_for_review`. `prefillPermitted` is true only after every gate passes, and
`autoSubmitEnabled` is `false` in every state. Today every MyJobScotland job reaches
`unavailable` with reason `adapter_execution_disabled`.

Customer Service Advisor GLA15975 is recorded in the external-submission ledger, so it resolves to
`already_submitted` before any other check runs.

### What is not built

- No worker mode executes real-site actions. The validator, mapper and resolver are complete and
  tested, but nothing drives a browser against a real domain, deliberately.
- Reinspecting the page after takeover is specified by the adapter's human-only steps but has no
  execution path yet, for the same reason.
- `employment.history` holds one role while four leaving reasons are recorded, so even with prefill
  enabled only the first employment row could be filled from verified facts. The rest would be
  questions. Adding the missing roles to the profile is a user action, not a code change.

### Supervised pilot attempt on the real tracker, 2026-09-28

Run against the user's real database and profile. No synthetic profile was used and no
re-onboarding happened. Three defects were found on real data that the test suite had not caught.

**1. Equal-opportunities boilerplate cancelled a genuine eligibility restriction.**

`detectInternalOnlyRestriction` downgraded `restricted` to `unclear` whenever the advert also
contained an "explicitly open" phrase, and `we welcome applications from everyone` was on that
list. That sentence is diversity boilerplate and appears on most council adverts. The result: the
Business Support Officer (QA) advert, which says _"Please note, this opportunity is only open to
current employees and ILMs of JBG"_, stayed **shortlisted at 55**. The earlier fix had been proven
only against synthetic text that lacked the boilerplate.

Fixed by removing that pattern; the openness list now contains only phrases that address internal
versus external eligibility. Four real adverts are now correctly detected as restricted, and no
false positives appeared across the nine full adverts in the tracker. Two of them had been
shortlisted:

| Advert                                                       | Was            | Now                                           |
| ------------------------------------------------------------ | -------------- | --------------------------------------------- |
| Business Support Officer (QA)                                | shortlisted 55 | rejected, `restricted_to_internal_candidates` |
| Administrative Officer (Children Residential Admin Services) | shortlisted 53 | rejected, same                                |

**2. A matcher change did not reach already-scored jobs.**

`MATCHER_VERSION` is part of the match-run idempotency key, so a decision recorded for an unchanged
job, profile and configuration is reused rather than recalculated. That is what makes results
reproducible, and it also means a safety fix silently does not apply to anything already in the
tracker until the version moves. The first re-score after fixing defect 1 reported
`evaluated: 0, reused: 32` and changed nothing.

`MATCHER_VERSION` is now `shadow-1.4.0`, and the constant carries a comment saying that a
behaviour change must bump it. Re-running then reported `evaluated: 32` and produced the table
above.

**3. The manual handoff omitted the applicant's name.**

The preparation route's fact allowlist matched `identity.first_name` and `identity.last_name`. A
real profile stores `identity.legal_name`, so the name was missing from the copy-ready pack
entirely, along with notice period and earliest start date. The allowlist now covers
`identity.legal_name` and `eligibility.*`; the pack went from 15 facts to 18. Work authorisation
and anything sensitive stay excluded deliberately: those are declarations the person makes.

The preparation response now also carries a nine-step `checklist`, which names the human-only steps
rather than implying them, and the tracker renders it.

### The permission question, answered

`https://www.myjobscotland.gov.uk/robots.txt` reads:

```
User-agent: *
Disallow: /api/
Disallow: /user/register/
Disallow: /user/password/
Disallow: /user/login/
Disallow: /user/logout/
Disallow: /my-organisations/
```

Public advert pages are not disallowed, which is consistent with the existing reviewed read policy.
The **authenticated candidate area and the login flow are explicitly disallowed to all automated
agents**, and that is precisely where an application is filled in. This is documented evidence
against automated form interaction, not merely an absence of permission.

Prefill therefore stays disabled, and `myJobScotlandAdapter` keeps `executionMode: 'disabled'`.
Nothing in this session changed that. What would unblock it is written permission from the
recruiting council or MyJobScotland, recorded as the policy's evidence, as
`docs/permission-request-draft.md` sets out — a robots.txt cannot be overridden by inference.

## Next implementation

1. Observe a specific employer's application flow with the user performing login and authentication.
   Record only field structure and navigation; exclude personal values, session data and credentials.
2. Record the exact application domain, site policy and permitted automation level. Leave unclear
   permissions in manual mode.
3. Add a separate real adapter and worker mode with a domain allowlist. Do not loosen the fake-only
   validator or point a fake application at a production site.
4. Add an authenticated preparation endpoint tied to the user, canonical job and existing application
   ledger. Duplicate, closed and unsupported jobs must not start a new browser attempt.
5. Resolve answers only from approved facts and approved documents. Unknown and human-only fields
   pause for the user. Revalidate the page after takeover.
6. Show the exact answer/CV review and preserve checkpoints. Final submission stays with the user in
   this pilot. Store submitted status only with explicit user confirmation or a verified receipt;
   ambiguous results remain unresolved and cannot be automatically retried.
7. Test the supported form against fixtures before one supervised pilot application.

This work applies to the first application adapter. Discovery from other boards and company sites
continues through their separate reviewed source adapters.
