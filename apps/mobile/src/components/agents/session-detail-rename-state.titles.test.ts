import { describe, expect, it } from 'vitest';

import { namedSessionTitle } from './session-detail-rename-state';

describe('namedSessionTitle', () => {
  it('returns undefined for a missing, null or blank title', () => {
    expect(namedSessionTitle(undefined)).toBeUndefined();
    expect(namedSessionTitle(null)).toBeUndefined();
    expect(namedSessionTitle('   ')).toBeUndefined();
  });

  it('returns undefined for the backend placeholder titles', () => {
    expect(namedSessionTitle('New session - 2026-09-22T02:05:22.778Z')).toBeUndefined();
    expect(namedSessionTitle('Child session - 2026-09-22T02:05:22.778Z')).toBeUndefined();
  });

  it('returns the trimmed title for a real name', () => {
    expect(namedSessionTitle('  Fix login  ')).toBe('Fix login');
  });
});
