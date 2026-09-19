import { describe, expect, it } from 'vitest';

import {
  COMMENT_TRAILING_CONTROLS_GAP_DP,
  commentTrailingControlsClearanceDp,
  FIX_WITH_KILO_HIT_SLOP,
} from '@/lib/pr-review/comment-trailing-controls';

describe('comment trailing controls tap areas', () => {
  it('keeps the pill and the overflow hit areas apart', () => {
    // The regression this guards: the overflow's 8pt left hitSlop used to
    // reach into the pill's right edge, so a tap on the pill opened the
    // moderation sheet instead of the session.
    expect(commentTrailingControlsClearanceDp()).toBeGreaterThan(0);
  });

  it('preserves the pill hitSlop', () => {
    expect(FIX_WITH_KILO_HIT_SLOP).toEqual({ top: 10, bottom: 10, left: 2, right: 2 });
  });

  it('derives the clearance from the gap and the pill hitSlop', () => {
    expect(commentTrailingControlsClearanceDp()).toBe(
      COMMENT_TRAILING_CONTROLS_GAP_DP - FIX_WITH_KILO_HIT_SLOP.right
    );
  });
});
