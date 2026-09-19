import { describe, expect, it } from 'vitest';

import {
  hitSlopPerSide,
  MIN_TAP_TARGET_CLASS,
  MIN_TAP_TARGET_DP,
  TOUCH_TARGET_DP,
} from './tap-target';

describe('tap-target geometry', () => {
  it('declares a 28dp minimum box and names it in the class string', () => {
    expect(MIN_TAP_TARGET_DP).toBe(28);
    expect(MIN_TAP_TARGET_CLASS).toContain(`min-h-[${MIN_TAP_TARGET_DP}px]`);
    expect(MIN_TAP_TARGET_CLASS).toContain(`min-w-[${MIN_TAP_TARGET_DP}px]`);
    expect(MIN_TAP_TARGET_CLASS).toContain('items-center');
    expect(MIN_TAP_TARGET_CLASS).toContain('justify-center');
  });

  it('lifts the minimum box to the 44pt design target on every side', () => {
    expect(TOUCH_TARGET_DP).toBe(44);
    expect(MIN_TAP_TARGET_DP + hitSlopPerSide(MIN_TAP_TARGET_DP) * 2).toBeGreaterThanOrEqual(
      TOUCH_TARGET_DP
    );
  });

  it('never returns a negative slop for a control already at the target', () => {
    expect(hitSlopPerSide(TOUCH_TARGET_DP)).toBe(0);
    expect(hitSlopPerSide(60)).toBe(0);
  });
});
