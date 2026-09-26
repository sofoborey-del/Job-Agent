# Real application preparation and adapter pilot

The tracker now offers **Prepare application**. It reads the current tracked job and match evidence,
shows eligibility concerns and uncertain requirements, checks the closing date and advert status,
and offers **Open application site**. It creates no attempt and makes no submission claim.

Real browser prefill remains unavailable. A supported adapter must be implemented before the
preparation panel can start a real attempt; the fake-ATS start endpoint must never be used as its
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
