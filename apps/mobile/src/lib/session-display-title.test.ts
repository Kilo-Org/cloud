import { describe, expect, it } from 'vitest';

import { displayableSessionTitle } from './session-display-title';

describe('displayableSessionTitle', () => {
  it('returns undefined for null, undefined and blank titles', () => {
    expect(displayableSessionTitle(null)).toBeUndefined();
    expect(displayableSessionTitle(undefined)).toBeUndefined();
    expect(displayableSessionTitle('')).toBeUndefined();
    expect(displayableSessionTitle('   ')).toBeUndefined();
  });

  it('returns undefined for the ingest machine placeholder title', () => {
    expect(displayableSessionTitle('New session - 2026-09-22T16:37:00.000Z')).toBeUndefined();
    expect(displayableSessionTitle('Child session - 2026-09-22T16:37:00.000Z')).toBeUndefined();
  });

  it('returns a real title, trimmed', () => {
    expect(displayableSessionTitle('Implementation plan')).toBe('Implementation plan');
    expect(displayableSessionTitle('  Implementation plan  ')).toBe('Implementation plan');
  });

  it('keeps a user title that only shares the placeholder prefix', () => {
    // The pattern is anchored to the full machine timestamp, so a human title
    // that happens to start the same way is not swallowed.
    expect(displayableSessionTitle('New session - implementation plan')).toBe(
      'New session - implementation plan'
    );
  });
});
