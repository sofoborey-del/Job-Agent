/**
 * Shows your real tracked adverts grouped the way the tracker now groups them.
 *
 *   node --env-file=.env scripts/shortlist-grouping-report.mjs
 *
 * This exists for the Phase 1B shortlist-quality gate. The score could not be signed off because it
 * sat in a 17-point band across every real advert and therefore ranked nothing. This prints what
 * replaced it: which vacancies the agent could actually check, which it read but could not judge,
 * which it never read at all, and which are blocked outright. Judge that, not the score.
 *
 * It reads the local database and writes nothing. It prints vacancy titles, which are public advert
 * content, and never prints an applicant value.
 */
import { PGlite } from '@electric-sql/pglite';

import { createTrackingStores, PGliteDatabase } from '../packages/db/dist/index.js';
import { groupByShortlistBand, shortlistBandLabels } from '../packages/tracking/dist/index.js';

const userId = process.env.AGENT_USER_ID;
if (!userId) {
  console.error('AGENT_USER_ID is not set. Run with --env-file=.env.');
  process.exit(1);
}

const pglite = await PGlite.create(process.env.PGLITE_DATA_DIR);
const stores = createTrackingStores(new PGliteDatabase(pglite));
const page = await stores.tracking.list({ userId, limit: 200, sort: 'score_desc' });

if (page.jobs.length === 0) {
  console.log('No tracked jobs. Run discovery first.');
  await pglite.close();
  process.exit(0);
}

const groups = groupByShortlistBand(page.jobs, (job) => job.assessment.band);

for (const group of groups) {
  console.log(`\n== ${shortlistBandLabels[group.band]} (${group.entries.length}) ==`);
  for (const job of group.entries) {
    const a = job.assessment;
    const checked =
      a.criteriaSeen === 0 ? '  --' : `${a.criteriaChecked}/${a.criteriaSeen}`.padStart(5);
    const score = job.score === null ? ' --' : String(job.score).padStart(3);
    console.log(
      `  ${checked} checked  score ${score}  ${job.reviewStatus.padEnd(11)} ${job.title.slice(0, 46)}`,
    );
    console.log(`         ${a.summary}`);
  }
}

// The measure the gate actually turns on: how many vacancies the agent has an opinion worth reading.
const useful = page.jobs.filter(
  (job) => job.assessment.band === 'fully_checked' || job.assessment.band === 'partly_checked',
).length;
const seen = page.jobs.reduce((total, job) => total + job.assessment.criteriaSeen, 0);
const checked = page.jobs.reduce((total, job) => total + job.assessment.criteriaChecked, 0);
const scores = page.jobs.map((job) => job.score).filter((score) => score !== null);

console.log(`\nadverts: ${page.jobs.length}`);
console.log(`requirements read: ${seen}, of which checked against your profile: ${checked}`);
console.log(`adverts where the agent could check something: ${useful}`);
if (scores.length > 1) {
  console.log(
    `score range across all adverts: ${Math.min(...scores)} to ${Math.max(...scores)} ` +
      `(a narrow band here is exactly why the tracker no longer leads with it)`,
  );
}

await pglite.close();
