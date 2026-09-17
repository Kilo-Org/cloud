// Tap-area geometry for the trailing controls of one review-comment row: the
// "Fix with Kilo" pill and the overflow (moderation) button beside it.
//
// Both controls are compact and rely on `hitSlop` to reach the 44pt minimum
// touch target (DESIGN.md). The pill's expanded right edge and the overflow's
// expanded left edge must never meet: a tap on the pill — including its right
// edge — must open the session, never the moderation sheet. Keeping the
// arithmetic in one place lets the row's gap and the two hit slops be checked
// together (vr1, 2026-09-16).

/**
 * The pill's hit slop: vertical only, plus a 2pt horizontal cap so it cannot
 * reach into the neighboring overflow button's expanded hit area.
 */
export const FIX_WITH_KILO_HIT_SLOP = { top: 10, bottom: 10, left: 2, right: 2 } as const;

/** The overflow's hit slop: its 28pt visual button + 8pt per side = 44pt. */
export const COMMENT_ACTIONS_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;

/** The trailing group's `gap-3` class, in dp. */
export const COMMENT_TRAILING_CONTROLS_GAP_DP = 12;

/**
 * Horizontal dp between the pill's expanded right edge and the overflow's
 * expanded left edge. A positive value means the two tap areas never overlap,
 * so each control keeps every tap that lands on it.
 */
export function commentTrailingControlsClearanceDp(): number {
  return (
    COMMENT_TRAILING_CONTROLS_GAP_DP - FIX_WITH_KILO_HIT_SLOP.right - COMMENT_ACTIONS_HIT_SLOP.left
  );
}
