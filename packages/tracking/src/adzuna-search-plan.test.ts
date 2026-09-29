import { describe, expect, it } from 'vitest';

import { adzunaSearches, planAdzunaSearches } from './adzuna-search-plan.js';

describe('the bounded Adzuna search plan', () => {
  it('covers the applicant’s target role families and remote leads within one result budget', () => {
    const plan = planAdzunaSearches(25, 0);
    expect(plan).toHaveLength(adzunaSearches.length);
    expect(plan.reduce((total, search) => total + search.maxItems, 0)).toBe(25);
    expect(plan.map((search) => search.what)).toEqual(adzunaSearches.map((search) => search.what));
    expect(plan.filter((search) => search.where === undefined)).toHaveLength(2);
    expect(plan.every((search) => search.maxItems > 0)).toBe(true);
  });

  it('rotates priority when the cap is smaller than the search set', () => {
    expect(planAdzunaSearches(2, 0).map((search) => search.what)).toEqual([
      'customer service',
      'administration',
    ]);
    expect(planAdzunaSearches(2, 1).map((search) => search.what)).toEqual([
      'administration',
      'insurance',
    ]);
    expect(planAdzunaSearches(0, 0)).toEqual([]);
  });
});
