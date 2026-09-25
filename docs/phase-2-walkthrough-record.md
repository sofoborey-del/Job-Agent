# Phase 2 walkthrough record

This is a transcript of one complete practice application, run end to end against the bundled fake
ATS with a real Chromium browser. It is here so the Phase 2 exit gate can be read rather than only
performed, and so you can compare it against what you see when you run it yourself.

Reproduce it with:

```bash
pnpm browser:install   # once per machine
pnpm walkthrough:phase2
```

The script starts its own fake job site on a loopback port, uses a throwaway in-memory database,
and invents an applicant who does not exist. It reads no real profile, no real CV and no real
vacancy site, and it cannot reach anything outside `127.0.0.1`.

## What to look for

| Step | The claim it evidences                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| 1    | The agent fills only fields backed by a verified fact, and stops on the two it cannot recognise.            |
| 2    | Your answers unblock it, and it then stops again at the sensitive questions it is never allowed to answer.  |
| 3    | Every value that reached the form traces back to a fact or to something you typed. Nothing invented.        |
| 4    | Manual takeover works, and resume is refused until nothing is outstanding.                                  |
| 5    | The review names the evidence behind each answer, and sensitive answers carry no preview and no hash.       |
| 6    | Approval is bound to that exact review. A changed review is refused.                                        |
| 7    | Exactly one practice submission, and a second is impossible.                                                |
| 8    | A form that rejects the first attempt is handled without guessing, and never looped more than three rounds. |
| 9    | An unclear submission outcome goes to reconciliation and is never retried automatically.                    |

## Transcript

```text
Practice application walkthrough

Practice job site: http://127.0.0.1:41617   (loopback only, started by this script)
Employer involved: none. This is the bundled fake ATS.
Applicant data:    synthetic. No real profile or CV is read.

==============================================================================
STEP 1. The agent opens the form and fills only what it can evidence
==============================================================================
It stopped on the "details" step. Reason: questions_open.

Questions it will not answer by itself:
  - favourite_colour (unknown field) — The form asks "Which colour best describes your working style? An invented question with no equivalent in any profile." and the agent does not recognise it. How should it be answered?
  - referral_code (unknown field) — The form asks "Internal referral code, if you were given one" and the agent does not recognise it. How should it be answered?

What it did fill, and on what evidence:
  - contract_preference <- verified fact (1 evidence reference)
  - email <- verified fact (1 evidence reference)
  - first_name <- verified fact (1 evidence reference)
  - last_name <- verified fact (1 evidence reference)
  - phone <- verified fact (1 evidence reference)
  - relocate <- verified fact (1 evidence reference)
  - right_to_work <- verified fact (1 evidence reference)
  - supporting_statement <- verified fact (1 evidence reference)
  - years_experience <- verified fact (1 evidence reference)

==============================================================================
STEP 2. You answer the questions, and it carries on
==============================================================================
Answered 2 question(s), stored for this application only.
Steps completed: details, history, documents
It stopped again on "questions". Reason: human_only_step.

These are the ones it is not allowed to answer at all:
  - disability (sensitive question)
  - criminal_record (sensitive question)
  - ethnicity (sensitive question)

Application state: WAITING_TAKEOVER. It is waiting for you, not retrying.

==============================================================================
STEP 3. Checking what actually reached the form
==============================================================================
CV uploaded: synthetic-cv.pdf
Every value on the form traces back to a verified fact or to an answer you gave. Nothing was invented.

==============================================================================
STEP 4. You take over for the parts only a person may do
==============================================================================
Agent stopped. Completing the sensitive, declaration and consent steps as the user would.
  - questions completed by the user
  - checks completed by the user
  - declarations completed by the user
The browser is now on: /apply/a11f1ae2b6e8af9a6c/review
Resume accepted: true. Resumed.

==============================================================================
STEP 5. The review you approve
==============================================================================
Review reference: 8c8b4cd6976ee094...
Outstanding questions: 0
CV attached, by hash:  97e687ab7ba72602...
Adapter version:       fake-ats 2.0.0

Every answer, and where it came from:
  - contract_preference        evidence: 1 fact reference
  - email                      evidence: 1 fact reference
  - favourite_colour           you answered this
  - first_name                 evidence: 1 fact reference
  - last_name                  evidence: 1 fact reference
  - phone                      evidence: 1 fact reference
  - referral_code              you answered this
  - relocate                   evidence: 1 fact reference
  - right_to_work              evidence: 1 fact reference
  - supporting_statement       evidence: 1 fact reference
  - years_experience           evidence: 1 fact reference
  - cv                         approved_document
  - education_grade_0          evidence: 1 fact reference
  - education_institution_0    evidence: 1 fact reference
  - education_qualification_0  evidence: 1 fact reference
  - education_year_0           evidence: 1 fact reference
  - employment_duties_0        evidence: 1 fact reference
  - employment_employer_0      evidence: 1 fact reference
  - employment_end_0           evidence: 1 fact reference
  - employment_job_title_0     evidence: 1 fact reference
  - employment_start_0         evidence: 1 fact reference
  - criminal_record            you completed this; the agent never saw it
  - disability                 you completed this; the agent never saw it
  - ethnicity                  you completed this; the agent never saw it

No sensitive answer carries a preview or a hash in the review.

==============================================================================
STEP 6. Approval is bound to that exact review
==============================================================================
Approved review 8c8b4cd6976ee094...
A changed review is refused: snapshot_changed

==============================================================================
STEP 7. One practice submission, and only one
==============================================================================
Submission stopped early: false
Fake confirmation reference: FAKE-ATS-1BA8D76D
Application state: SUBMITTED
Submission ledger:  confirmed
A second submission is refused: state_not_ready
Times the fake site recorded a submission: 1
Reference the fake site holds:             FAKE-ATS-1BA8D76D

==============================================================================
STEP 8. Rehearsal: the form rejects the first attempt
==============================================================================
The fake site rejected the first submission of the details step.
Steps it got through anyway: details, history, documents
It stopped at "questions". Reason: human_only_step.
It re-read the page and corrected what the evidence supported.
It never retries more than three rounds. After that it stops and asks you.

==============================================================================
STEP 9. Rehearsal: the submission outcome is unclear
==============================================================================
The practice submission ran, but the site came back with no confirmation reference.
Application state:  SUBMISSION_UNKNOWN
Submission ledger:  unknown
It will not retry by itself: state_not_ready
An unclear outcome waits for you. A retry could create a second application, so it never guesses.

==============================================================================
Walkthrough finished. Nothing was sent to any employer.
==============================================================================
```

## Sign-off

The transcript is evidence that the mechanism works. It is not a substitute for your judgement on
whether the screens read clearly and the pauses land in sensible places. Run it yourself, then fill
in the sign-off block at the end of `docs/runbooks/phase-2-fake-ats.md`.
