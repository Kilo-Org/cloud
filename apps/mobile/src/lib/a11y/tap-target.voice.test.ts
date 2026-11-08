import { describe, expect, it, vi } from 'vitest';

import {
  composerControlClearanceDp,
  ICON_TARGET_DP,
  tapTargetReachDp,
  TOUCH_TARGET_DP,
  VOICE_INPUT_LG_FRAME_DP,
  VOICE_INPUT_LG_HIT_SLOP_DP,
  VOICE_INPUT_LG_VISUAL_DP,
} from './tap-target';

// `tap-target` imports react-native; the pure config runs without an app, so
// the native module is a mutable stub (the same mock `tap-target.test.ts` uses).
vi.mock('react-native', () => ({ I18nManager: { isRTL: false }, Platform: { OS: 'ios' } }));

/**
 * The composer input row's controls must not share or overlap tap areas — the
 * microphone's edge tap reading as a send is the audited regression — so the
 * row measures the voice toggle against the reach the separation gaps clear.
 */
describe('voice toggle lg geometry', () => {
  // The regression this guards: `lg` was a 35dp `h-10 w-10` frame whose 4dp
  // slop (facing side zeroed by the row) left the tap area at 43dp/39dp —
  // under both 44pt and 48dp. The minimum now sits on the pressable's own
  // node, the rect a control-size audit reads and the frame a screen reader
  // focuses; the slop keeps its shipped value, whose reach the separation
  // gaps still clear.
  it('carries the platform minimum on the pressable own frame over the slop reach', () => {
    expect(VOICE_INPUT_LG_FRAME_DP).toBe(ICON_TARGET_DP);
    // One frame serves both platforms: 48dp clears iOS's 44pt minimum too.
    expect(VOICE_INPUT_LG_FRAME_DP).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
    // The visible circle keeps the shipped 35dp size inside the frame.
    expect(VOICE_INPUT_LG_VISUAL_DP).toBe(35);
    expect(VOICE_INPUT_LG_HIT_SLOP_DP).toBe(4);
    expect(VOICE_INPUT_LG_FRAME_DP).toBeGreaterThanOrEqual(
      tapTargetReachDp(VOICE_INPUT_LG_VISUAL_DP, VOICE_INPUT_LG_HIT_SLOP_DP)
    );
  });

  it('keeps the row separation arithmetic intact over the wider frame', () => {
    expect(composerControlClearanceDp()).toBeGreaterThan(0);
  });
});
