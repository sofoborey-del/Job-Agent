# Runbook: preparing one application by hand

This is the fastest safe route from a shortlisted vacancy to a completed employer form. The agent
does the reading, the grounding and the bookkeeping. You do the typing, the declarations and the
sending.

It exists because assisted filling of a real employer form is **not permitted** — see
[`../real-application-pilot.md`](../real-application-pilot.md) for the permission review and the
exact blocker. This flow is what is genuinely available today, and it removes most of the retyping.

## Before the first run

You need these once, in this order. Each one is a local screen at `http://127.0.0.1:3210`.

1. **`/onboarding`** — create your profile and set `AGENT_USER_ID` in `.env` to the profile ID it
   gives you. Nothing else works until this is done.
2. **`/cv-review`** — upload your CV, read the extracted sections, and approve them. Approval binds
   to the file's SHA-256, so a changed file has to be reviewed again.
3. **`/profile-history`** — confirm the structured employment and education rows drafted from the CV
   sections you just approved. **This is the step that matters most for this runbook.** The
   preparation screen fills one role box per role you confirm here and not one more, so an
   unconfirmed history produces a pack full of "you answer this".
4. **`/leaving-reasons`** — link each recorded reason for leaving to the role it belongs to. Do this
   once; see below for why it is needed.
5. **`/answer-vault`** — optional. Save wording you are willing to reuse. Equality-monitoring
   answers here are never filled in for you and are never shown unless you tick them.

Then start the service:

```bash
pnpm api
```

## Preparing one application

If a search result says **Excerpt only**, open the original link and look for the employer's full
advert. A reviewed official MyJobScotland URL can be pasted into **Read the official advert** so
the agent can save and score the full criteria. For any other site that has not been reviewed, use
**Compare a full advert I copied**: paste the full advert, and paste any separate person
specification as well. That comparison is tentative and disappears when you leave the page. It
does not upgrade the tracked excerpt, prepare an application, or contact the employer. You may
manually shortlist the lead for your own follow-up, but do not treat its tentative score as proof
that every prerequisite was met.

1. Open `http://127.0.0.1:3210/tracker`, enter your admin token and profile ID, and load your jobs.
2. On a shortlisted job, choose **Prepare application**. Read the eligibility concerns and the
   criteria first. If the job is closed, restricted to internal candidates, or already recorded as
   submitted, stop here — the screen will say so and will refuse to produce answers.
3. Choose **Open the full answer pack for this job**.
4. On `/application-prep`, enter your admin token. The profile ID and job ID arrive from the link.
5. Optionally tick any reusable answers you want shown for this application. Everything is unticked
   by default and there is no setting that changes that.
6. Choose **Show my answers for this job**.

You now have every question the form asks, in the order the form asks it, in one of three states:

| State               | Meaning                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| **Ready to copy**   | Taken word for word from a verified profile fact, with its source shown. Check it. |
| **You answer this** | The profile does not hold it. The agent will not guess, and states why it cannot.  |
| **Yours only**      | A declaration, a consent, an equality-monitoring question, a login, or a CAPTCHA.  |

**Copy every ready answer** puts the whole lot on the clipboard in form order. It never includes a
reusable answer, an equality-monitoring answer or a declaration, so a one-click copy cannot put a
demographic answer into a box you did not intend.

7. Open the employer's site yourself, sign in yourself, and work through the form, pasting as you go.
8. Attach the CV the pack names. Its SHA-256 prefix is shown so you can tell it is the file you
   approved.
9. Write the supporting statement yourself. The agent will not draft one, and will not reuse another
   application's statement as though it were written for this post. This is deliberate.
10. Answer right to work, disclosure, equality monitoring and every declaration yourself.
11. Read the completed form, then submit it yourself.
12. Come back to `/tracker` and record it under **I submitted this application myself**, with the
    employer's reference. From then on the vacancy is refused for preparation, so the same job
    cannot be applied for twice.

## What this flow will not do

- It will not open, fill or submit an employer form. There is no route that can.
- It will not invent an employer, a job title, a date, a duty, a reason for leaving, a qualification
  or a grade. A detail your profile does not hold becomes a question.
- It will not open more role or qualification boxes than your profile records. A form with five role
  boxes and two confirmed roles gives you two answered rows and says the rest are yours.
- It will not attach a reason for leaving to an employer that reason does not name.
- It will not answer the right-to-work question, even when your profile records an unconditional
  right to work. That is a declaration you make.
- It will not put a demographic answer anywhere unless you ticked that topic on that request.
- It will not produce a pack for a job that is closed, restricted to internal candidates, or already
  recorded as submitted.

## Why reasons for leaving need linking once

A reason for leaving is filed against an employer name. The agent joins it to a role by matching
that name **exactly**, and it will not loosen that: attaching a reason to an employer it does not
name would put a false statement on an application form.

On real data the join fails constantly for a dull reason. Employment rows are drafted from CV lines,
and a CV line often carries a town or a work pattern after the employer ("Example Ltd Glasgow
Hybrid"), while the reason was recorded against the bare name ("Example Ltd"). Same employer; the
agent cannot know that.

`/leaving-reasons` fixes it once. It shows every role and every recorded reason, and:

- **proposes** a pairing only where the recorded name is a whole-word prefix of the row's employer
  **and** that pairing is the only one possible in both directions;
- **proposes nothing** where a reason could belong to two roles, a role could take two reasons, or
  the names merely share a word — those are yours to choose;
- lets you link anything to anything, because you are the one who knows.

On save it re-files the reason against the exact employer string your history uses. **Your wording is
never altered**, what you originally typed is kept on the record, and the previous version survives
because facts are versioned. From then on those "Reason for leaving" boxes come out ready to copy.

Leaving a role set to "no reason recorded" is perfectly fine — a form asking for one will simply say
it is yours to fill in.

## If the pack is mostly "you answer this"

That is the profile, not the form. In order of effect:

1. Confirm your employment and education history on `/profile-history`.
2. Link your reasons for leaving on `/leaving-reasons`.
3. Approve a CV on `/cv-review` if the pack says none is available.
4. Add grades to your qualifications if the forms you meet ask for them.

Re-open the pack afterwards; it is recomputed from the profile on every request and nothing is
cached.

## Checks

```bash
pnpm check
```

The behaviour above is pinned by `packages/adapters/src/answer-pack.test.ts` (the grounding rules),
`apps/api/src/answer-pack-route.test.ts` (the same rules through the API, including the refusals, the
audit record and the demographic opt-in), and `packages/profile/src/leaving-reason-links.test.ts`
plus the route tests in `apps/api/src/server.test.ts` (the linking rules and their refusals). Route-level coverage is the one that counts
here: a flow proven only below the route passes while the route guard is missing.
