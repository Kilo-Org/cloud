import { describe, expect, it } from 'vitest';

import {
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP_DP,
  INLINE_LINK_BOX_CLASS,
  INLINE_LINK_HIT_SLOP_DP,
  MIN_TAP_TARGET_DP,
  tapTargetReachDp,
  TOUCH_TARGET_DP,
} from './tap-target';

describe('shared tap-target geometry', () => {
  it('keeps the control-size audit floor below the design touch target', () => {
    expect(MIN_TAP_TARGET_DP).toBe(28);
    expect(TOUCH_TARGET_DP).toBe(44);
    expect(COMPACT_CONTROL_HIT_SLOP_DP).toBe(8);
    expect(INLINE_LINK_HIT_SLOP_DP).toBe(10);
  });

  it('renders the compact control box from whole pixels that clear the audit floor', () => {
    expect(COMPACT_CONTROL_BOX_CLASS).toContain('h-[32px]');
    expect(COMPACT_CONTROL_BOX_CLASS).toContain('w-[32px]');
    expect(COMPACT_CONTROL_BOX_CLASS).toContain('items-center');
  });

  it('reaches the design touch target with the compact box plus its slop', () => {
    expect(tapTargetReachDp(32, 8)).toBe(48);
    expect(tapTargetReachDp(32, COMPACT_CONTROL_HIT_SLOP_DP)).toBe(48);
    expect(tapTargetReachDp(32, COMPACT_CONTROL_HIT_SLOP_DP)).toBeGreaterThanOrEqual(
      TOUCH_TARGET_DP
    );
  });

  it('carries an inline link from the audit floor to the design target with its slop', () => {
    expect(INLINE_LINK_BOX_CLASS).toContain('min-h-[28px]');
    expect(INLINE_LINK_BOX_CLASS).toContain('min-w-[28px]');
    expect(tapTargetReachDp(MIN_TAP_TARGET_DP, INLINE_LINK_HIT_SLOP_DP)).toBe(48);
    expect(tapTargetReachDp(MIN_TAP_TARGET_DP, INLINE_LINK_HIT_SLOP_DP)).toBeGreaterThanOrEqual(
      TOUCH_TARGET_DP
    );
  });
});
