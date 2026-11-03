import { CODE_REVIEW_STATUSES } from '@kilocode/app-shared/code-review';
import {
  NON_TERMINAL_CODE_REVIEW_STATUSES,
  TERMINAL_CODE_REVIEW_STATUSES,
} from './dispatch-constants';

describe('code review status sets', () => {
  it('classifies every app-shared status except interrupted', () => {
    const classified = [...NON_TERMINAL_CODE_REVIEW_STATUSES, ...TERMINAL_CODE_REVIEW_STATUSES];

    expect(new Set(classified).size).toBe(classified.length);
    expect([...CODE_REVIEW_STATUSES].sort()).toEqual([...classified, 'interrupted'].sort());
  });
});
