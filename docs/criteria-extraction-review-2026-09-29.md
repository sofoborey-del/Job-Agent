# Criteria extraction: what was wrong, what changed, what is still open

Dated 2026-09-29. Written to be read on its own, including by someone with no access to this
repository. It contains no applicant data, no secrets and no credentials. Job titles and employer
names are public advert content.

## Context

A standalone, self-hosted job-discovery agent. It reads public job adverts, scores them against a
local encrypted profile, and notifies its single user. It does not apply for anything: there is no
route that opens, fills or submits an employer form, and automatic submission is disabled.

Phase 1B of its plan has one outstanding exit gate: the user must confirm that shortlist quality is
useful on a representative set. That gate was reviewed on 2026-09-25 and **rejected**, on the
grounds that the agent was scoring an advert summary while the real criteria sat in an unopened
document. This note covers a re-examination of that gate on 2026-09-29.

## What was found

The blocker reported in September had been addressed at the document level: the agent now reads the
criteria document an advert links, and 5 of 10 real adverts had 6,000-19,500 characters of criteria
text stored locally, with 88 requirement rows in the database.

Three separate defects meant none of that reached a decision.

**1. The ten real adverts had never been re-scored.** They were last matched on 2026-09-26 under
matcher `shadow-1.3.0`. The criteria-extraction work shipped as `shadow-1.5.0`, and only newly
discovered leads were ever scored with it. The tracker displayed "0 criteria found" and "no
mandatory criteria visible" for every real advert.

The cause is a mistaken assumption recorded in the commit that introduced `shadow-1.5.0`: it states
that bumping the matcher version "reaches already-scored jobs". It does not. Jobs are selected for
re-matching on a `needs_rematch` flag, which is set when an advert's _content_ changes and never
when the _matcher_ changes. A version bump therefore re-scores nothing. **This is still unfixed**;
the ten adverts were re-scored by setting the flag manually.

**2. The extractor was reading the post's duties as the candidate's requirements.** A council role
profile puts duties and criteria in one document, under headings that no fixed list reliably
catches. The extractor required a recognised heading and then accepted any line inside it, so it
collected:

- `"Job Family/ Grade/Level:"` - a form label
- `"To supervise a team of clerical admin staff to support operations"` - a duty of the post
- `"To supervise, allocate and review work of admin team"` - a duty of the post

A duty is not something an applicant either has or lacks, so every one of these was recorded as an
unknown requirement. The extractor also caps at 25 criteria. On these profiles the numbered duties
came first and filled all 25 slots, so the criteria table at the end of the document was never
reached. The adverts were scored on their duties while their actual requirements went unread - the
September failure one layer down.

**3. Text reflowing let a heading absorb the line after it.** A criteria table headed
`"Criteria Essential Desirable Evidence"` was joined to its first criterion. The word "Desirable"
then appeared inside that criterion, and the rule that excludes optional criteria discarded it. On
one advert this alone reduced nine criteria to one.

## What was changed

Section detection is now a negative gate rather than a positive one. Lines are considered unless
they sit under a heading known to describe the post. In its place, the sentence itself is read: a
line is taken only when it states something the applicant has or lacks, and never when it states
what the post does. A heading no longer absorbs the following line.

Measured with the repository's own `pnpm criteria:report` against the same ten real adverts:

| Measure                                  | Before                                           | After                 |
| ---------------------------------------- | ------------------------------------------------ | --------------------- |
| Requirements extracted across 10 adverts | 25 per advert, capped, largely duties and labels | 100, genuine criteria |
| Criteria evidenced against the profile   | 0                                                | 5                     |
| Worst case                               | 1 criterion on a 9,916-character specification   | 8                     |

Those figures cover all ten adverts. The deployed re-score covers the nine that are eligible for
re-matching, giving 81 criteria of which 4 are evidenced; the difference is the expired advert.

Test suite: 600 passing across 51 files.

## What is still open, and why it was not "fixed"

**Most criteria cannot be evidenced.** 86 of the 100 extracted criteria resolve to `unknown`. The
agent cannot judge prose such as "significant experience within Organisational Development" against
a structured profile. Consequently scores sit between 37 and 54 across all ten adverts and do not
separate them much. A shortlist where everything scores in a 17-point band is not ranking.

**The 25-criterion cap now truncates genuine criteria** on the longest specification.

Both of these change scores, and this project's own standing instruction is that scoring thresholds
and weightings are to be decided deliberately through versioned configuration rather than tuned in
passing. Neither was touched.

**Every rejection is a hard gate, not a score.** After the change, four of the ten adverts are
rejected, and all four carry `restricted_to_internal_candidates`: they are open only to an
employer's existing staff, and no amount of evidence can satisfy that. Not one advert is rejected on
score. This bounds the risk of the narrow scoring band: the shortlist currently fails to rank, but it
is not discarding anything a person would want to see. It also explains an apparent inconsistency -
an advert rejected at 54 while another is shortlisted at 53 - which is the gate, not the score.

One advert has expired. Expired adverts are excluded from re-matching by lifecycle, so it still
carries its 26 September decision and its criteria were never re-read.

## The recommendation

The shortlist-quality gate should **not** be signed off yet. The extraction defect is fixed and
measurable, but the reason the shortlist cannot rank has moved rather than gone: criteria are now
read correctly and still cannot be evidenced. Signing off now would certify a ranking that is not
ranking.

The next decision is whether to invest in evidencing prose criteria against the profile, or to
accept that the agent surfaces candidates for a human to judge and stop scoring them as though it
could rank them. That is a design decision, not a bug.

## Questions worth a second opinion

1. Is evidencing free-text criteria against a structured profile worth attempting deterministically,
   or is the honest answer that a shortlist should present criteria for a human to check rather than
   produce a score?
2. If scores cannot discriminate, is a score the right interface at all, versus grouping by hard
   gates passed and criteria coverage?
3. Should the criteria cap be a count at all, or should it be bounded by document section?
