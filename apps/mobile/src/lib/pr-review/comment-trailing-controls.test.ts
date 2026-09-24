import { describe, expect, it } from 'vitest';

import { MIN_TAP_TARGET_DP } from '@/lib/a11y/tap-target';
import {
  COMMENT_ACTIONS_FRAME_DP,
  COMMENT_ACTIONS_HIT_SLOP,
  COMMENT_ACTIONS_VISUAL_DP,
  COMMENT_TRAILING_CONTROLS_GAP_DP,
  commentTrailingControlsClearanceDp,
  FIX_WITH_KILO_HIT_SLOP,
  FIX_WITH_KILO_VISUAL_DP,
} from '@/lib/pr-review/comment-trailing-controls';

describe('comment trailing controls tap areas', () => {
  it('keeps the pill and the overflow hit areas apart', () => {
    // The regression this guards: the overflow's 8pt left hitleed used to
    // reach into the pill's right edge, so a tap on the pill opened the
    // moderation sheet instead of the session.
    expect(commentTrailingControlsClearanceDp()).toBeGreaterThan(0);
  });

  it('keeps the overflow frame at or above the 28dp the size audit measures', () => {
    // h-7 measured 24.5dp on device (NativeWind's rem is 14pt) and was
    // reported as too small to tap.
    expect(COMMENT_ACTIONS_FRAME_DP).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    expect(COMMENT_ACTIONS_VISUAL_DP).toBeLessThan(COMMENT_ACTIONS_FRAME_DP);
  });

  it('keeps both controls at the 44pt minimum touch target', () => {
    // The pill renders 23pt tall (FIX_WITH_KILO_VISUAL_DP: a 1rem `text-xs`
    // line box, `py-1` per side and the border, at NativeWind's 14pt rem), so
    // the overflow reaches 44pt from its frame plus the slop on every side and
    // the pill needs its own vertical slop to get there.
    expect(
      COMMENT_ACTIONS_FRAME_DP + COMMENT_ACTIONS_HIT_SLOP.top + COMMENT_ACTIONS_HIT_SLOP.bottom
    ).toBeGreaterThanOrEqual(44);
    expect(
      FIX_WITH_KILO_HIT_SLOP.top + FIX_WITH_KILO_HIT_SLOP.bottom + FIX_WITH_KILO_VISUAL_DP
    ).toBeGreaterThanOrEqual(44);
  });

  it('derives the clearance from the gap and the two facing slops', () => {
    // The gap and both tap areas are measured from the frames, so the overflow
    // frame's inset around its visible circle does not enter here. `gap-3` is
    // 0.75rem, which is 10.5dp at NativeWind's 14pt rem, so the pill's 2pt
    // right slop and the overflow's 3pt left slop leave 5.5dp.
    expect(commentTrailingControlsClearanceDp()).toBe(
      COMMENT_TRAILING_CONTROLS_GAP_DP -
        FIX_WITH_KILO_HIT_SLOP.right -
        COMMENT_ACTIONS_HIT_SLOP.left
    );
    expect(commentTrailingControlsClearanceDp()).toBe(5.5);
  });
});
