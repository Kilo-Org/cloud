// The tab row's pills render 31.5pt tall, under the design touch target, so the
// slop is what carries them to it. These guards hold the arithmetic and the
// slop's shape together: a frame that grew past the target would make the slop
// redundant, and a horizontal slop would reach into the `gap-1` neighbour.

import { describe, expect, it, vi } from 'vitest';

import { tapTargetReachDp, TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';
import {
  PR_REVIEW_TAB_FRAME_DP,
  PR_REVIEW_TAB_HIT_SLOP,
  PR_REVIEW_TAB_HIT_SLOP_DP,
} from '@/lib/pr-review/pr-review-tab-target';

vi.mock('react-native', () => ({ I18nManager: { isRTL: false }, Platform: { OS: 'ios' } }));

describe('PR review tab tap target', () => {
  it('reaches the design touch target with its vertical slop', () => {
    expect(
      tapTargetReachDp(PR_REVIEW_TAB_FRAME_DP, PR_REVIEW_TAB_HIT_SLOP_DP)
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
  });

  it('renders a frame the slop has to lift', () => {
    // The slop exists because the frame is short. A frame that reached the
    // target on its own would leave the slop as unused surface, and this guard
    // would fail so the file is revised rather than kept.
    expect(PR_REVIEW_TAB_FRAME_DP).toBeLessThan(TOUCH_TARGET_DP);
  });

  it('gives the tab the same slop above and below', () => {
    expect(PR_REVIEW_TAB_HIT_SLOP.top).toBe(PR_REVIEW_TAB_HIT_SLOP_DP);
    expect(PR_REVIEW_TAB_HIT_SLOP.bottom).toBe(PR_REVIEW_TAB_HIT_SLOP_DP);
  });

  it('keeps the slop off the sides the neighbour tab occupies', () => {
    // The pills sit `gap-1` (3.5pt) apart, so any horizontal slop would overlap
    // the neighbouring tab's touch area.
    expect(Object.keys(PR_REVIEW_TAB_HIT_SLOP)).toEqual(['top', 'bottom']);
  });
});
