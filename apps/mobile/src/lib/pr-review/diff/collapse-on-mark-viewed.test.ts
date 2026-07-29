import { describe, expect, it } from 'vitest';

import { collapseOnMarkViewed } from './collapse-on-mark-viewed';

describe('collapseOnMarkViewed', () => {
  it('collapses an expanded path when marking viewed', () => {
    const expanded = { 'a.ts': true, 'b.ts': true };
    expect(collapseOnMarkViewed(expanded, 'a.ts', false)).toEqual({
      'a.ts': false,
      'b.ts': true,
    });
  });

  it('returns the same reference when un-marking (never re-expands)', () => {
    const expanded = { 'a.ts': false, 'b.ts': true };
    expect(collapseOnMarkViewed(expanded, 'a.ts', true)).toBe(expanded);
  });

  it('returns the same reference when path is already collapsed', () => {
    const expanded = { 'a.ts': false };
    expect(collapseOnMarkViewed(expanded, 'a.ts', false)).toBe(expanded);
  });

  it('returns the same reference when path is absent (falsy)', () => {
    const expanded = { 'b.ts': true };
    expect(collapseOnMarkViewed(expanded, 'a.ts', false)).toBe(expanded);
  });
});
