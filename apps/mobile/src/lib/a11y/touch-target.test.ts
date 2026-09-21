import { describe, expect, it } from 'vitest';

import {
  COMPACT_CONTROL_FRAME_DP,
  COMPACT_CONTROL_HIT_SLOP_DP,
  compactControlTargetDp,
  MIN_AUDITED_CONTROL_FRAME_DP,
} from '@/lib/a11y/touch-target';

describe('compact icon control touch target', () => {
  it('keeps the measured frame at or above the 28dp audited floor', () => {
    // The regression this guards: a control sized to its glyph (or to a
    // rem-scaled h-7, which measures 24.5dp) is reported as too small to tap.
    expect(COMPACT_CONTROL_FRAME_DP).toBeGreaterThanOrEqual(MIN_AUDITED_CONTROL_FRAME_DP);
  });

  it('reaches the app 44pt minimum touch target from the frame plus its slop', () => {
    expect(COMPACT_CONTROL_HIT_SLOP_DP).toBeGreaterThan(0);
    expect(compactControlTargetDp()).toBeGreaterThanOrEqual(44);
  });
});
