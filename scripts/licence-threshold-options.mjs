// Models the ways of handling a role that matches well but carries a mandatory requirement the
// profile has no evidence for, such as PVG membership or a driving licence.
//
// It changes nothing. It runs the existing corpus through the existing matcher, then recomputes
// what each option would have decided, so the trade-off can be seen rather than guessed at.
import { readFileSync } from 'node:fs';

import { defaultAgentConfig } from '../packages/config/dist/index.js';
import { calculateScore, shadowMatch } from '../packages/matching/dist/index.js';

const corpus = JSON.parse(
  readFileSync(new URL('../tests/fixtures/shadow-corpus.json', import.meta.url), 'utf8'),
);
const facts = corpus.profileFacts.map((fact) => ({
  ...fact,
  status: 'verified',
  source: 'user',
  sensitivity: 'normal',
  usePolicy: 'auto_fill',
  allowedPurposes: ['matching', 'application'],
  version: 1,
}));
const now = new Date('2026-09-25T00:00:00.000Z');
const { shortlist, approvalPrefill } = defaultAgentConfig.matching.thresholds;

const pad = (text, width) => String(text).padEnd(width);

/** The matcher's own banding, so a modelled score is labelled the way the real one would be. */
function bandFor(score, hardRejected) {
  if (hardRejected) return 'reject';
  if (score < shortlist) return 'reject';
  if (score < approvalPrefill) return 'shortlist';
  return 'prefill_with_approval';
}

const rows = [];
for (const entry of corpus.cases) {
  const result = shadowMatch(entry.job, facts, undefined, now);
  const requirements = result.requirements;
  const total = requirements.length;
  const met = requirements.filter((requirement) => requirement.outcome === 'met').length;
  const unknown = requirements.filter((requirement) => requirement.outcome === 'unknown').length;
  const hardRejected = result.decision.hardRejectReasons.length > 0;

  // The matcher's own dimensions, rebuilt from the signals it reports, so each option can change
  // one input and leave every other part of the calculation exactly as it is.
  const { titleFit, skillsFit, experienceFit, locationFit, contractFit } = result.signals;
  const baseDimensions = {
    mandatoryCoverage: total === 0 ? 0.6 : met / total,
    relevantSkills: skillsFit,
    relevantExperience: experienceFit,
    locationFit,
    compensationQuality:
      result.salaryGate === 'pass' ? 1 : result.salaryGate === 'unknown' ? 0.4 : 0,
    otherPreferences: (titleFit + contractFit) / 2,
  };
  const preferredCriteriaNotMet = contractFit < 0.5 ? 1 : 0;

  // Option B: an unevidenced mandatory requirement counts as half covered rather than a total
  // miss, on both the coverage dimension and the weak-evidence penalty.
  const scoreB = calculateScore(
    {
      ...baseDimensions,
      mandatoryCoverage: total === 0 ? 0.6 : Math.min(1, (met + unknown * 0.5) / total),
    },
    preferredCriteriaNotMet,
    (total - met) * 0.5,
  );

  // Option C asks a narrower question: if the unknown requirements turned out to be met, would
  // this role clear the threshold on its own merits? Only then is it worth your time.
  const scoreIfMet = calculateScore(
    {
      ...baseDimensions,
      mandatoryCoverage: total === 0 ? 0.6 : Math.min(1, (met + unknown) / total),
    },
    preferredCriteriaNotMet,
    Math.max(0, total - met - unknown),
  );
  // How well the role fits you setting the requirements aside entirely: skills, experience,
  // location and title, as a percentage of the 50 points those four dimensions can carry.
  const roleFit = Math.round(
    ((skillsFit * 20 + experienceFit * 15 + locationFit * 10 + ((titleFit + contractFit) / 2) * 5) /
      50) *
      100,
  );

  // Option C asks only where the answer would change the outcome AND the role is a decent fit
  // on its own merits. Without the second test it would ask about roles that are simply not
  // for you, because the score is dominated by the requirements dimension.
  const worthAsking =
    !hardRejected &&
    result.decision.score < shortlist &&
    unknown > 0 &&
    scoreIfMet >= shortlist &&
    roleFit >= 60;

  rows.push({
    name: entry.name,
    score: result.decision.score,
    action: result.decision.action,
    unknown,
    total,
    hardRejected,
    scoreB,
    scoreIfMet,
    roleFit,
    actionB: bandFor(scoreB, hardRejected),
    actionC: worthAsking ? 'ask you about the requirement' : result.decision.action,
  });
}

console.log('Unevidenced mandatory requirements: what each option would do');
console.log('');
console.log(
  `Thresholds: reject below ${String(shortlist)}, shortlist ${String(shortlist)}-${String(approvalPrefill - 1)}, prefill at ${String(approvalPrefill)}+.`,
);
console.log('Synthetic corpus only. Nothing is applied for and no configuration is changed.');
console.log('');
console.log(
  `${pad('Advert', 34)}${pad('Unknowns', 10)}${pad('Fit', 6)}${pad('Now', 26)}${pad('Option B', 26)}${'Option C'}`,
);
console.log('-'.repeat(132));
for (const row of rows) {
  console.log(
    pad(row.name.slice(0, 32), 34) +
      pad(`${String(row.unknown)}/${String(row.total)}`, 10) +
      pad(`${String(row.roleFit)}%`, 6) +
      pad(`${row.action} (${String(row.score)})`, 26) +
      pad(`${row.actionB} (${String(row.scoreB)})`, 26) +
      row.actionC,
  );
}

const affected = rows.filter(
  (row) => row.unknown > 0 && row.action === 'reject' && !row.hardRejected,
);
const changedB = rows.filter((row) => row.actionB !== row.action);
const changedC = rows.filter((row) => row.actionC !== row.action);

console.log('');
console.log('='.repeat(126));
console.log('');
console.log('The problem, stated plainly');
console.log('');
console.log(
  `  ${String(affected.length)} advert(s) here are rejected without you ever seeing them, and at least part of the`,
);
console.log('  reason is a mandatory requirement your profile has no evidence for.');
for (const row of affected) {
  console.log(
    `    "${row.name}" scores ${String(row.score)}, fit ${String(row.roleFit)}%. If those ${String(row.unknown)} requirement(s) were met it would score ${String(row.scoreIfMet)}.`,
  );
}
console.log('');
console.log('  Worth noticing: the score cannot tell those two situations apart on its own.');
console.log('  Requirements carry 40 of the 100 points, so an advert with every requirement');
console.log('  unmatched scores low whether it suits you or not. The "Fit" column is the four');
console.log('  dimensions that describe the role itself, with the requirements set aside.');
console.log('  A high fit and a low score means a licence problem. A low fit means a poor match.');

console.log('');
console.log('Option A. Leave it alone.');
console.log('  Nothing changes. You keep a clean shortlist and never hear about these roles.');
console.log('  Reasonable if you would not pursue a role needing a licence you do not hold.');
console.log('');

console.log('Option B. Count an unevidenced mandatory requirement as half met.');
console.log(`  Adverts whose outcome changes: ${String(changedB.length)}`);
for (const row of changedB) {
  console.log(
    `    ${row.name}: ${row.action} (${String(row.score)}) -> ${row.actionB} (${String(row.scoreB)})`,
  );
}
console.log('  Cost: it lifts every advert with an unmatched requirement, not just the licence');
console.log('  ones, so genuinely poor matches climb too and the score means less than it did.');
console.log('');

console.log('Option C. Ask, but only where the answer would change the outcome.');
console.log('  A role is surfaced only when all three hold: it falls short today, it would clear');
console.log('  the threshold if the unknown requirement were met, and its fit is at least 60%.');
console.log(`  Adverts whose outcome changes: ${String(changedC.length)}`);
for (const row of changedC) {
  console.log(
    `    ${row.name}: ${row.action} (${String(row.score)}, fit ${String(row.roleFit)}%) -> ${row.actionC}, would score ${String(row.scoreIfMet)} if met`,
  );
}
console.log('  Cost: a short question now and then, such as "this one wants PVG, do you have it?"');
console.log('  Answer once and it becomes a verified fact, so it stops being asked.');
console.log('');
console.log('In all three options the safety property is unchanged: an unknown mandatory');
console.log('requirement can never let anything proceed automatically.');
