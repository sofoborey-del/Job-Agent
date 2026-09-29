import { describe, expect, it } from 'vitest';

import { draftHistoryFromReviewedCv } from './cv-history-draft.js';

describe('reviewed CV history draft', () => {
  it('drafts dated roles and qualifications without claiming that employer locations are known', () => {
    const draft = draftHistoryFromReviewedCv(
      'Customer Adviser Jul 2025 – Jun 2026\nExample Firm Remote / Glasgow\n• Supported customers.\n• Maintained records.\nFraud Associate Jan 2024 – May 2025\nExample Bank Edinburgh\n• Reviewed cases.',
      'Security Certificate — Example Institute | Completed May 2025\nProfessional Diploma — Example College | In progress, commenced January 2026\nHND (part-completed) — Example College | 2015',
    );
    expect(draft.employment).toHaveLength(2);
    expect(draft.employment[0]).toMatchObject({
      employer: 'Example Firm Remote / Glasgow',
      title: 'Customer Adviser',
      startDate: 'Jul 2025',
      endDate: 'Jun 2026',
      evidenceSummary: '• Supported customers. • Maintained records.',
    });
    expect(draft.warnings).toContain(
      'Check every employer name: a CV line may include a town or work pattern after it.',
    );
    expect(draft.education).toHaveLength(3);
    expect(draft.education[1]).toMatchObject({
      qualification: 'Professional Diploma',
      startDate: 'January 2026',
      endDate: null,
    });
    expect(draft.education[2]?.qualification).toContain('part-completed');
  });

  it('does not guess undated roles or an unrecognised education line', () => {
    const draft = draftHistoryFromReviewedCv(
      'Customer Adviser\nExample Firm\nHelped customers.',
      'Unstructured training line',
    );
    expect(draft.employment).toEqual([]);
    expect(draft.education).toEqual([]);
    expect(draft.warnings).toContain(
      'No dated roles could be extracted automatically. Add them from the CV before confirming.',
    );
  });
});
