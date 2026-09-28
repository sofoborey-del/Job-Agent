/**
 * Measures what requirement extraction and scoring do to the real tracked adverts.
 *
 * Run it before and after a change to the extractor, and compare. Scoring consequences are
 * supposed to be decided deliberately, which means seeing the numbers move rather than assuming
 * they will.
 *
 *   node --env-file=.env scripts/criteria-extraction-report.mjs
 *
 * It reads the local database and writes nothing. It prints vacancy titles and requirement
 * sentences, which are public advert content, and never prints an applicant value.
 */
import { PGlite } from '@electric-sql/pglite';

import { PGliteDatabase, PGliteProfileRepository } from '../packages/db/dist/index.js';
import { defaultAgentConfig } from '../packages/config/dist/index.js';
import { shadowMatch } from '../packages/matching/dist/index.js';
import { ProfileService } from '../packages/profile/dist/index.js';
import { FieldCipher, StaticEncryptionKeyProvider } from '../packages/security/dist/index.js';

const userId = process.env.AGENT_USER_ID;
if (!userId) {
  console.error('AGENT_USER_ID is not set. Run with --env-file=.env.');
  process.exit(1);
}

const pglite = await PGlite.create(process.env.PGLITE_DATA_DIR);
const database = new PGliteDatabase(pglite);
const cipher = new FieldCipher(
  StaticEncryptionKeyProvider.fromBase64(
    process.env.APP_ENCRYPTION_KEY_ID,
    process.env.APP_ENCRYPTION_KEY_BASE64,
  ),
);
const facts = await new ProfileService(new PGliteProfileRepository(database), cipher).listFacts(
  userId,
);

const rows = await pglite.query(
  `SELECT j.id, j.title, j.description, j.description_completeness, j.person_spec_status,
          j.person_spec_text, j.location_json, j.contract_type, j.employment_types,
          j.work_pattern, j.closes_at, j.salary_min_minor, j.salary_max_minor, j.salary_basis,
          j.salary_confidence, j.salary_source_text, c.canonical_name AS employer,
          t.review_status, t.score AS stored_score
     FROM jobs j
     JOIN companies c ON c.id = j.company_id
     JOIN job_tracking t ON t.job_id = j.id AND t.user_id = $1
    WHERE j.description_completeness = 'full'
    ORDER BY t.score DESC NULLS LAST`,
  [userId],
);

function shadowJobFor(row) {
  const salary =
    row.salary_min_minor === null && row.salary_max_minor === null
      ? null
      : {
          ...(row.salary_min_minor === null ? {} : { minimumMinor: Number(row.salary_min_minor) }),
          ...(row.salary_max_minor === null ? {} : { maximumMinor: Number(row.salary_max_minor) }),
          currency: 'GBP',
          basis: row.salary_basis ?? 'unknown',
          confidence: Number(row.salary_confidence ?? 0.5),
          sourceText: row.salary_source_text ?? '',
        };
  return {
    id: row.id,
    title: row.title,
    employer: row.employer,
    description: row.description,
    location: (row.location_json && row.location_json.text) || '',
    salary,
    contractType: row.contract_type,
    employmentTypes: Array.isArray(row.employment_types) ? row.employment_types : [],
    workPattern: row.work_pattern,
    closesAt: row.closes_at ? new Date(row.closes_at).toISOString() : null,
    personSpecification: {
      status: row.person_spec_status ?? 'absent',
      ...(row.person_spec_text ? { text: row.person_spec_text } : {}),
    },
  };
}

const verbose = process.argv.includes('--show-requirements');
let totalRequirements = 0;

console.log(
  `${'score'.padEnd(7)}${'action'.padEnd(23)}${'reqs'.padEnd(6)}${'met'.padEnd(5)}${'notMet'.padEnd(8)}${'unknown'.padEnd(9)}${'spec'.padEnd(11)}title`,
);
for (const row of rows.rows) {
  const result = shadowMatch(shadowJobFor(row), facts, defaultAgentConfig);
  const met = result.requirements.filter((r) => r.outcome === 'met').length;
  const unknown = result.requirements.filter((r) => r.outcome === 'unknown').length;
  const notMet = result.requirements.filter((r) => r.outcome === 'not_met').length;
  totalRequirements += result.requirements.length;
  console.log(
    `${String(result.decision.score).padEnd(7)}${result.decision.action.padEnd(23)}` +
      `${String(result.requirements.length).padEnd(6)}${String(met).padEnd(5)}` +
      `${String(notMet).padEnd(8)}${String(unknown).padEnd(9)}` +
      `${String(result.criteria.personSpecification).padEnd(11)}${row.title.slice(0, 42)}`,
  );
  if (verbose) {
    for (const requirement of result.requirements.slice(0, 8)) {
      console.log(`         [${requirement.outcome}] ${requirement.text.slice(0, 104)}`);
    }
  }
}
console.log(
  `\nadverts: ${rows.rows.length}   requirements extracted in total: ${totalRequirements}`,
);

await pglite.close();
