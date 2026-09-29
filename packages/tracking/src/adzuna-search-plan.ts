/**
 * A small, bounded set of searches based on the applicant's stated target role families.
 * These are search leads, not evidence that a vacancy meets the applicant's prerequisites.
 * Keep each request narrow enough to make the limited result budget useful across categories.
 */
export const adzunaSearches = [
  { what: 'customer service', where: 'Glasgow' },
  { what: 'administration', where: 'Glasgow' },
  { what: 'insurance', where: 'Glasgow' },
  { what: 'fraud', where: 'Glasgow' },
  { what: 'compliance', where: 'Glasgow' },
  { what: 'financial services', where: 'Glasgow' },
  { what: 'remote customer service' },
  { what: 'remote administrator' },
] as const;

export type PlannedAdzunaSearch = {
  what: string;
  where?: string;
  maxItems: number;
};

/** Spread the source's total result cap across queries; rotate priority if the cap is small. */
export function planAdzunaSearches(maxItemsPerRun: number, slot: number): PlannedAdzunaSearch[] {
  if (!Number.isInteger(maxItemsPerRun) || maxItemsPerRun < 1) return [];
  const start = ((slot % adzunaSearches.length) + adzunaSearches.length) % adzunaSearches.length;
  const ordered = [...adzunaSearches.slice(start), ...adzunaSearches.slice(0, start)];
  const count = Math.min(maxItemsPerRun, ordered.length);
  const base = Math.floor(maxItemsPerRun / count);
  const extra = maxItemsPerRun % count;
  return ordered.slice(0, count).map((search, index) => ({
    ...search,
    maxItems: base + (index < extra ? 1 : 0),
  }));
}
