import { describe, expect, it } from 'vitest';

import {
  COMMENT_ACTIONS_HIT_SLOP,
  COMMENT_TRAILING_CONTROLS_GAP_DP,
  commentTrailingControlsClearanceDp,
  FIX_WITH_KILO_HIT_SLOP,
} from '@/lib/pr-review/comment-trailing-controls';

describe('comment trailing controls tap areas', () => {
  it('keeps the pill and the overflow hit areas apart', () => {
    // The regression this guards: the overflow's 8pt left hitleed used to
    // reach into the pill's right edge, so a tap on the pill opened the
    // moderation sheet instead of the session.
    expect(commentTrailingControlsClearanceDp()).toBeGreaterThan(0);
  });

  it('keeps both controls at the 44pt minimum touch target', () => {
    // The overflow is a 28pt visual button; the pill is ~26pt tall.
    expect(
      COMMENT_ACTIONS_HIT_SLOP.top + COMMENT_ACTIONS_HIT_SLOP.bottom + 28
    ).toBeGreaterThanOrEqual(44);
    expect(FIX_WITH_KILO_HIT_SLOP.top + FIX_WITH_KILO_HIT_SLOP.bottom + 26).toBeGreaterThanOrEqual(
      44
    );
  });

  it('derives the clearance from the gap and both hit slops', () => {
    expect(commentTrailingControlsClearanceDp()).toBe(
      COMMENT_TRAILING_CONTROLS_GAP_DP -
        FIX_WITH_KILO_HIT_SLOP.right -
        COMMENT_ACTIONS_HIT_SLOP.left
    );
  });
});
