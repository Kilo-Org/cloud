import { describe, expect, it } from 'vitest';

import {
  COMPACT_CONTROL_FRAME_DP,
  COMPACT_CONTROL_HIT_SLOP_DP,
  compactControlTargetDp,
  COMPOSER_CONTROL_GAP_DP,
  COMPOSER_CONTROL_HIT_SLOP_DP,
  composerControlClearanceDp,
  MIN_AUDITED_CONTROL_FRAME_DP,
  VOICE_INPUT_LG_HIT_SLOP_DP,
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

describe('composer input row control separation', () => {
  it('spells the row gap as the rem width of the class the row applies', () => {
    // `ms-3` is 0.75rem, and NativeWind's rem measures 14pt on device, so the
    // constant and the class have to move together.
    expect(COMPOSER_CONTROL_GAP_DP).toBe(0.75 * 14);
  });

  it('leaves positive clearance between two adjacent controls tap areas', () => {
    // The regression this guards: the send/stop control carried no gap, so it
    // rendered flush against the microphone and the two tap areas overlapped.
    expect(composerControlClearanceDp()).toBeGreaterThan(0);
  });

  it('derives the clearance from the gap and the two facing slops', () => {
    expect(composerControlClearanceDp()).toBe(
      COMPOSER_CONTROL_GAP_DP - VOICE_INPUT_LG_HIT_SLOP_DP - COMPOSER_CONTROL_HIT_SLOP_DP
    );
  });
});
