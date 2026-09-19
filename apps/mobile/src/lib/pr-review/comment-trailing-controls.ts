// Tap-area geometry for the trailing controls of one review-comment row: the
// "Fix with Kilo" pill and the overflow (moderation) button beside it.
//
// The pill uses hitSlop; the overflow owns a 44pt native target without it.
// The pill's expanded right edge must not reach the overflow: a tap on the
// pill — including its right edge — must open the session, never moderation.

/**
 * The pill's hit slop: vertical only, plus a 2pt horizontal cap so it cannot
 * reach into the neighboring overflow button's hit area.
 */
export const FIX_WITH_KILO_HIT_SLOP = { top: 10, bottom: 10, left: 2, right: 2 } as const;

/** The trailing group's `gap-3` class, using NativeWind's 14pt rem. */
export const COMMENT_TRAILING_CONTROLS_GAP_DP = 10.5;

/**
 * Horizontal dp between the pill's expanded right edge and the overflow's
 * left edge. A positive value means the two tap areas never overlap,
 * so each control keeps every tap that lands on it.
 */
export function commentTrailingControlsClearanceDp(): number {
  return COMMENT_TRAILING_CONTROLS_GAP_DP - FIX_WITH_KILO_HIT_SLOP.right;
}
