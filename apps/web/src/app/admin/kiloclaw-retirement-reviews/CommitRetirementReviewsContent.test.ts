import { describe, expect, it } from '@jest/globals';

import { flattenReviewCasePages } from './CommitRetirementReviewsContent';

describe('flattenReviewCasePages', () => {
  it('appends older cases and removes duplicate page-boundary rows', () => {
    const newest = { reviewCase: { id: 'newest' } };
    const boundary = { reviewCase: { id: 'boundary' } };
    const older = { reviewCase: { id: 'older' } };

    const rows = flattenReviewCasePages([
      { rows: [newest, boundary] },
      { rows: [boundary, older] },
    ]);

    expect(rows.map(row => row.reviewCase.id)).toEqual(['newest', 'boundary', 'older']);
  });
});
