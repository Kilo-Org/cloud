import { describe, expect, it } from 'vitest';

import { hitSlopForRow } from './diff-target';

describe('hitSlopForRow', () => {
  it('returns symmetric horizontal padding so the touchable target is wider than the visible row', () => {
    const hitSlop = hitSlopForRow();
    expect(hitSlop.left).toBeGreaterThan(0);
    expect(hitSlop.right).toBeGreaterThan(0);
    expect(hitSlop.left).toBe(hitSlop.right);
  });

  it('does not expand vertically, because contiguous rows would overlap and mis-route taps', () => {
    const hitSlop = hitSlopForRow();
    expect(hitSlop).not.toHaveProperty('top');
    expect(hitSlop).not.toHaveProperty('bottom');
  });

  it('is deterministic (pure: depends only on constants)', () => {
    expect(hitSlopForRow()).toEqual(hitSlopForRow());
  });
});
