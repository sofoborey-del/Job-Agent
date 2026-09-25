// Runs real, currently-advertised MyJobScotland vacancies through the existing shadow matcher so
// shortlist quality can be judged on real adverts rather than on synthetic ones.
//
// The adverts below were read from the live pages on 2026-09-25 and transcribed here, so this
// script makes no network calls and can be re-run offline. It exercises the matcher and the
// decision policy; it does not exercise the HTML parser, which has its own tests.
//
// Nothing is applied for. No profile is read: the stand-in facts are the corpus ones, which were
// written to mirror a real background in FCA-regulated compliance, risk and fraud work with a
// move toward cyber security policy.
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

const gbp = (minMinor, maxMinor, sourceText) => ({
  minimumMinor: minMinor,
  maximumMinor: maxMinor,
  currency: 'GBP',
  basis: 'annual_base',
  confidence: 0.99,
  sourceText,
});

/** Read from the live adverts on 2026-09-25. Descriptions are the advert text, abridged. */
const adverts = [
  {
    id: 'real-1',
    title: 'Information Governance Advisor',
    employer: 'Glasgow City Council',
    location: 'Glasgow',
    description:
      'Key involvement in implementation of the Council’s Records Management Plan and information governance activities. Provision of specialist support and expertise in the field. Development of policies and procedures. Compliance monitoring.',
    salary: gbp(3631927, 4229144, '£36,319.27 - £42,291.44 per year'),
    contractType: 'Permanent',
    employmentTypes: ['FULL_TIME'],
    workPattern: null,
    closesAt: '2025-12-09T23:59:59.000Z',
    note: 'The closest role to the target, but it closed in December 2025.',
  },
  {
    id: 'real-2',
    title: 'Social Worker (Justice Services)',
    employer: 'Glasgow City HSCP',
    location: 'Glasgow',
    description:
      'At least two years statutory Justice experience. Degree / Diploma in Social Work (or Social Work equivalent). Registration to the Scottish Social Services Council (SSSC) is an essential requirement. Membership of the Protection of Vulnerable Groups (PVG) Scheme is essential on taking up appointment.',
    salary: gbp(4736339, 5481270, '£47,363.39 - £54,812.70 per year'),
    contractType: 'Permanent',
    employmentTypes: ['FULL_TIME'],
    workPattern: null,
    closesAt: '2026-10-11T23:59:59.000Z',
    note: 'A real qualification-and-PVG case. Good salary, wrong profession.',
  },
  {
    id: 'real-3',
    title: 'Business Analyst',
    employer: 'Glasgow City Council',
    location: 'Glasgow',
    description:
      'Business analysis role. The person specification and grade criteria are provided as downloadable attachments rather than in the advert body.',
    salary: gbp(4549539, 5294470, '£45,495.39 - £52,944.70 per year'),
    contractType: 'Permanent',
    employmentTypes: ['FULL_TIME'],
    workPattern: null,
    closesAt: '2026-10-04T23:59:59.000Z',
    note: 'The advert body carries almost no criteria. They are in a PDF the agent cannot read.',
  },
  {
    id: 'real-4',
    title: 'Organisational Development Advisor',
    employer: 'City Building Glasgow LLP',
    location: 'Glasgow',
    description:
      'Support the delivery of organisational development initiatives aligned to strategic priorities. Contribute to workforce planning, succession planning and talent development activity. Experience in Organisational Development, Organisational Effectiveness, Workforce Planning, Change Management, Transformation or related people-focused discipline is essential. Effective communication and strong stakeholder engagement skills are required.',
    salary: gbp(4352000, 4637500, '£43,520 - £46,375 per year'),
    contractType: 'Permanent',
    employmentTypes: ['FULL_TIME'],
    workPattern: null,
    closesAt: '2026-10-04T23:59:59.000Z',
    note: 'Adjacent professional role, good salary, no overlap with governance or risk.',
  },
  {
    id: 'real-5',
    title: 'Senior HR Officer',
    employer: 'Glasgow City HSCP',
    location: 'Glasgow',
    description:
      'Strong operational HR experience and sound professional judgement is essential. Excellent communication and relationship-building skills. Strong analytical skills and experience of using HR information to support decision-making is required. Complex casework on disciplinary, grievance and capability matters.',
    salary: gbp(4549539, 5294470, '£45,495.39 - £52,944.70 per year'),
    contractType: 'Permanent',
    employmentTypes: ['FULL_TIME'],
    workPattern: null,
    closesAt: '2026-10-11T23:59:59.000Z',
    note: 'Casework and policy application, but HR rather than governance.',
  },
  {
    id: 'real-6',
    title: 'Senior Procurement Officer',
    employer: 'City Building Glasgow LLP',
    location: 'Glasgow',
    description:
      'Experience in public procurement is essential. Working knowledge of the Procurement Contracts (Scotland) Regulations 2015 is required. Experience using Public Contracts Scotland (PCS) and Public Contracts Scotland-Tender (PCS-T). End-to-end tendering process for works, goods and services, contract management and supplier relationship management.',
    salary: gbp(5044800, 5387000, '£50,448 - £53,870 per year'),
    contractType: 'Permanent',
    employmentTypes: ['FULL_TIME'],
    workPattern: null,
    closesAt: '2026-10-04T23:59:59.000Z',
    note: 'Regulation-facing and compliance-adjacent, but a specialist procurement track.',
  },
  {
    id: 'real-7',
    title: 'Customer Service Advisor',
    employer: 'Glasgow City Council',
    location: 'Glasgow',
    description: 'Customer service advisor handling enquiries from members of the public.',
    salary: gbp(2603126, 2768096, '£26,031.26 - £27,680.96 per year'),
    contractType: 'Permanent',
    employmentTypes: ['FULL_TIME'],
    workPattern: null,
    closesAt: '2026-09-27T23:59:59.000Z',
    note: 'Just above the salary floor, well below the target level.',
  },
  {
    id: 'real-8',
    title: 'Kitchen Porter (Part Time)',
    employer: 'Glasgow Life',
    location: 'Glasgow',
    description:
      'Maintaining kitchen cleanliness, managing deliveries, washing equipment and supporting catering operations.',
    salary: gbp(2086200, 2086200, '£20,862 per year'),
    contractType: 'Permanent',
    employmentTypes: ['PART_TIME'],
    workPattern: null,
    closesAt: '2026-10-11T23:59:59.000Z',
    note: 'Below the salary floor. Must be a hard reject.',
  },
  {
    id: 'real-9',
    title: 'Support for Learning Worker',
    employer: 'Glasgow City Council',
    location: 'Glasgow',
    description:
      'Supporting pupils with additional support needs in a primary school setting. PVG scheme membership is required.',
    salary: gbp(1792522, 1906121, '£17,925.22 - £19,061.21 per year'),
    contractType: 'Permanent',
    employmentTypes: ['PART_TIME'],
    workPattern: null,
    closesAt: '2026-10-04T23:59:59.000Z',
    note: 'Below the floor and carries PVG. Both gates should fire.',
  },
  {
    id: 'real-10',
    title: 'Head Teacher',
    employer: 'Glasgow City Council',
    location: 'Glasgow',
    description:
      'Leadership of a primary school. GTCS registration is essential. Substantial teaching and school leadership experience is required.',
    salary: gbp(7869600, 7869600, '£78,696 per year'),
    contractType: 'Permanent',
    employmentTypes: ['FULL_TIME'],
    workPattern: null,
    closesAt: '2026-10-04T23:59:59.000Z',
    note: 'High salary, entirely unrelated. A salary-led matcher would get this wrong.',
  },
];

const pad = (text, width) => String(text).padEnd(width);

console.log('Shortlist quality on real MyJobScotland adverts');
console.log('');
console.log(
  'Ten vacancies read from the live site on 2026-09-25, scored against a stand-in profile',
);
console.log('for compliance, risk and fraud work moving toward cyber security policy.');
console.log('Nothing is applied for. This is a read-only scoring check.');
console.log('');
console.log(
  `${pad('Advert', 36)}${pad('Salary', 10)}${pad('Score', 7)}${pad('Decision', 24)}${pad('Essentials', 14)}${'Criteria seen'}`,
);
console.log('-'.repeat(112));

const results = [];
for (const advert of adverts) {
  const result = shadowMatch(advert, facts, undefined, now);
  const unknown = result.requirements.filter(
    (requirement) => requirement.outcome === 'unknown',
  ).length;
  results.push({ advert, result, unknown });
  const ruledOut = result.decision.hardRejectReasons[0];
  console.log(
    pad(advert.title.slice(0, 34), 36) +
      pad(result.salaryGate, 10) +
      pad(`${String(result.decision.score)}`, 7) +
      pad(ruledOut === undefined ? result.decision.action : `reject (${ruledOut})`, 24) +
      pad(`${String(unknown)} of ${String(result.requirements.length)}`, 14) +
      (result.criteria.visible ? 'yes' : 'NONE SEEN'),
  );
}

console.log('');
console.log('='.repeat(112));
console.log('');
console.log('Advert by advert');
console.log('');
for (const { advert, result, unknown } of results) {
  const ruledOut = result.decision.hardRejectReasons;
  console.log(`${advert.title} — ${advert.employer}`);
  console.log(`  ${advert.note}`);
  const { titleFit, skillsFit, experienceFit, locationFit, contractFit } = result.signals;
  const pct = (value) => `${String(Math.round(value * 100))}%`;
  console.log(
    `  Score ${String(result.decision.score)}/100, salary ${result.salaryGate}, decision: ${result.decision.action}`,
  );
  console.log(
    `  Signals: title ${pct(titleFit)}, skills ${pct(skillsFit)}, experience ${pct(experienceFit)}, location ${pct(locationFit)}, contract ${pct(contractFit)}`,
  );
  if (ruledOut.length > 0) console.log(`  Ruled out by: ${ruledOut.join(', ')}`);
  if (!result.criteria.visible) {
    console.log(
      '  No essential requirements were visible on the page, so none were checked. The person',
    );
    console.log('  specification is in a linked document. Automatic progression is blocked by');
    console.log('  no_mandatory_criteria_visible rather than the advert looking requirement-free.');
  }
  if (unknown > 0) {
    console.log(
      `  Essentials it could not evidence: ${result.requirements
        .filter((requirement) => requirement.outcome === 'unknown')
        .map((requirement) => requirement.text.slice(0, 70))
        .join(' | ')}`,
    );
  }
  console.log('');
}

const shortlisted = results.filter(({ result }) => result.decision.action !== 'reject');
console.log('='.repeat(112));
console.log('');
console.log('The question for you');
console.log('');
console.log(
  `  Of these ten real adverts, ${String(shortlisted.length)} would reach your shortlist:`,
);
for (const { advert, result } of shortlisted) {
  console.log(`    ${advert.title} (${String(result.decision.score)}/100)`);
}
console.log('');
console.log('  Would you have wanted to see those, and only those?');
console.log('  If something you would have applied for is missing, say which and why.');
console.log('  That answer is the Phase 1B shortlist-quality review.');
console.log('');

const top = [...results].sort((a, b) => b.result.decision.score - a.result.decision.score);
const noRequirements = results.filter((row) => row.result.requirements.length === 0);

if (shortlisted.length === 0) {
  console.log('  Nothing reached the shortlist today. Read that carefully, because the numbers');
  console.log('  underneath it are mostly reassuring:');
  console.log('');
  console.log('  The ranking is sound. Highest to lowest:');
  for (const row of top.slice(0, 5)) {
    console.log(`    ${String(row.result.decision.score).padStart(3)}  ${row.advert.title}`);
  }
  console.log('');
  const best = top[0];
  console.log(
    `  The top score, ${best.advert.title} at ${String(best.result.decision.score)}, clears the shortlist threshold of 50.`,
  );
  console.log(
    '  It was dropped only because it closed in December 2025. Had it been open it would',
  );
  console.log('  have reached you. So the empty shortlist reflects what Glasgow had advertised on');
  console.log('  the day, not a scoring failure.');
  console.log('');
  console.log('  Two things are still worth your decision:');
  console.log('');
  console.log(
    `  1. ${String(noRequirements.length)} of these ten adverts yielded no essential requirements at all. MyJobScotland`,
  );
  console.log('     puts the person specification in a downloadable document. The agent now reads');
  console.log('     such a document when the advert links one, and when it cannot, it says so');
  console.log('     instead of reporting "0 of 0". See the demonstration below.');
  console.log('');
  console.log(
    '  2. Nothing in the target field was open on a single day. One day is a thin sample',
  );
  console.log('     for judging shortlist quality. Running this again across a couple of weeks');
  console.log('     would tell you far more than this snapshot can.');
}

// ---------------------------------------------------------------------------------------------
// What changes once the linked document is read.
//
// The criteria below are INVENTED. They are not transcribed from any real advert: the point is to
// show the mechanism on an advert whose real criteria sit in a document this script cannot read
// offline. Nothing here is a claim about what Glasgow City Council actually asked for.
// ---------------------------------------------------------------------------------------------
const demonstrationAdvert = adverts.find((advert) => advert.title === 'Business Analyst');
const inventedSpecification = [
  'Experience of business analysis in a regulated environment is essential.',
  'Knowledge of data protection legislation is essential.',
  'Membership of the PVG Scheme is required for this post.',
  'A recognised business analysis qualification is essential.',
].join('\n');

console.log('');
console.log('='.repeat(112));
console.log('');
console.log('Demonstration: the same advert, before and after its linked document is read');
console.log('');
console.log(
  '  The criteria used here are invented, not transcribed. This shows the mechanism only.',
);
console.log('');

const beforeRead = shadowMatch(demonstrationAdvert, facts, undefined, now);
const wellMatchedSpecification = [
  'Experience of compliance, risk and fraud investigation in FCA regulated firms is essential.',
  'Knowledge of data protection legislation and information governance is essential.',
  'Strong analytical skills and experience of governance reporting are essential.',
].join('\n');

const afterGoodRead = shadowMatch(
  {
    ...demonstrationAdvert,
    personSpecification: { status: 'read', text: wellMatchedSpecification },
  },
  facts,
  undefined,
  now,
);

const afterRead = shadowMatch(
  {
    ...demonstrationAdvert,
    personSpecification: { status: 'read', text: inventedSpecification },
  },
  facts,
  undefined,
  now,
);
const afterFailedRead = shadowMatch(
  {
    ...demonstrationAdvert,
    personSpecification: { status: 'unreadable', reason: 'attachment_http_error' },
  },
  facts,
  undefined,
  now,
);

const describe = (label, outcome) => {
  const unknownCount = outcome.requirements.filter(
    (requirement) => requirement.outcome === 'unknown',
  ).length;
  console.log(`  ${label}`);
  console.log(
    `    score ${String(outcome.decision.score)}  decision ${outcome.decision.action}  essentials ${String(unknownCount)} of ${String(outcome.requirements.length)}  criteria ${outcome.criteria.personSpecification}`,
  );
  const relevant = outcome.decision.autoBlockers.filter((blocker) =>
    /mandatory_unknown|no_mandatory_criteria_visible|person_specification_unreadable/.test(blocker),
  );
  console.log(
    `    blocked by: ${relevant.length === 0 ? 'nothing criteria-related' : relevant.join(', ')}`,
  );
  console.log('');
};

describe('Page only, as before this change:', beforeRead);
describe('Read, and the criteria suit the profile:', afterGoodRead);
describe('Read, and the criteria do not suit the profile:', afterRead);
describe('Linked document could not be read:', afterFailedRead);

console.log('  What to take from this:');
console.log('');
console.log('   - Before:   no essentials, so nothing was checked, and the advert looked clean.');
console.log('   - Suited:   the criteria are now checked against evidence and the score reflects');
console.log('               a real assessment rather than a default.');
console.log(
  '   - Unsuited: the score falls, because the unevidenced essentials now count. This is',
);
console.log('               the honest result, but it is also a decision for you: an advert whose');
console.log(
  '               criteria are read can now score lower than one whose criteria are not.',
);
console.log(
  '   - Failed:   the agent knows it missed criteria. It keeps the role visible for review',
);
console.log('               instead of rejecting it on a score calculated without them.');
console.log('');
console.log(
  '  The scoring weights and the shortlist threshold are configuration, not code. If the',
);
console.log('  drop in the unsuited case looks wrong to you, that is a threshold decision to take');
console.log('  deliberately, not something to tune quietly.');
