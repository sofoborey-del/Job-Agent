// Prints the deterministic decision for every advert in the review corpus.
// Synthetic data only. It makes no network calls and touches no applicant data.
import { readFileSync } from 'node:fs';

import { shadowMatch } from '../packages/matching/dist/index.js';

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

console.log('Shadow corpus review — synthetic adverts, no applications are made.\n');
for (const entry of corpus.cases) {
  const result = shadowMatch(entry.job, facts, undefined, now);
  const unknown = result.requirements.filter(
    (requirement) => requirement.outcome === 'unknown',
  ).length;
  console.log(`${entry.name}`);
  console.log(`  ${entry.note}`);
  console.log(
    `  action=${result.decision.action} score=${result.decision.score}/100 salary=${result.salaryGate} unknownEssentials=${unknown}`,
  );
  if (result.decision.hardRejectReasons.length > 0) {
    console.log(`  ruled out by: ${result.decision.hardRejectReasons.join(', ')}`);
  }
  console.log(
    `  blocked from anything automatic by: ${result.decision.autoBlockers.join(', ') || 'nothing'}`,
  );
  console.log('');
}
