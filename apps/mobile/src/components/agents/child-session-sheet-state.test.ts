import { describe, expect, it } from 'vitest';

import { getChildSessionSheetState } from './child-session-sheet-state';

describe('getChildSessionSheetState', () => {
  it('shows loading while hydration has not completed', () => {
    expect(getChildSessionSheetState({ status: 'loading' }, 0)).toBe('loading');
  });

  it('shows an empty state after successful hydration with no messages', () => {
    expect(getChildSessionSheetState({ status: 'ready' }, 0)).toBe('empty');
  });

  it('shows an error after failed hydration with no messages', () => {
    expect(getChildSessionSheetState({ status: 'error', message: 'Failed' }, 0)).toBe('error');
  });

  it('keeps rendering messages if a refresh fails', () => {
    expect(getChildSessionSheetState({ status: 'error', message: 'Failed' }, 1)).toBe('content');
  });
});
