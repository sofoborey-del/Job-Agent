import { extractMandatoryRequirements } from '@job-agent/matching';

import type { ExtractedJobRequirement } from './types.js';

function categorise(text: string): string {
  const lower = text.toLocaleLowerCase('en-GB');
  if (/\b(degree|hnd|hnc|svq|nvq|qualification|qualified|diploma|certif)/.test(lower))
    return 'qualification';
  if (
    /\b(licence|license|driving|pvg|disclosure|sc clearance|clearance|registered with)/.test(lower)
  )
    return 'licence';
  if (/\b(years?|experience|track record|background in|worked in)/.test(lower)) return 'experience';
  if (/\b(right to work|sponsor|visa|eligib)/.test(lower)) return 'work_authorisation';
  if (/\b(based in|travel to|on site|onsite|office|hybrid|remote|located)/.test(lower))
    return 'location';
  if (/\b(shift|weekend|out of hours|on call|availability|hours per week)/.test(lower))
    return 'availability';
  if (/\b(skill|knowledge of|proficient|competent|able to use|familiar with)/.test(lower))
    return 'skill';
  return 'other';
}

/**
 * Deterministic requirement extraction used at ingestion time. The same function feeds the
 * matcher, so a stored requirement and a scored requirement are always the same text.
 */
export function extractJobRequirements(
  description: string,
  personSpecificationText?: string | null,
): ExtractedJobRequirement[] {
  const fromAdvert = extractMandatoryRequirements(description);
  const fromSpecification =
    personSpecificationText === undefined || personSpecificationText === null
      ? []
      : extractMandatoryRequirements(personSpecificationText).filter(
          (text) => !fromAdvert.includes(text),
        );
  return [...fromAdvert, ...fromSpecification].map((text) => ({
    category: categorise(text),
    text,
    mandatory: true,
    evidenceExcerpt: text.slice(0, 500),
    extractionConfidence: 0.8,
  }));
}
