// Tap-area geometry for the trailing controls of one review-comment row: the
// "Fix with Kilo" pill and the overflow (moderation) button beside it.
//
// Both controls are compact, and their tap area is bigger than their visual: a
// control-size audit measures the frame a control renders, so the overflow's
// frame is `h-11 w-11` — 38.5pt on device, since NativeWind's rem is 14pt —
// around a 28pt visible circle, and 3pt of hit slop per side carries it to the
// 44pt minimum touch target (DESIGN.md). The pill's expanded right edge and the
// overflow's expanded left edge must never meet: a tap on the pill — including
// its right edge — must open the session, never the moderation sheet. Keeping
// the arithmetic in one place lets the row's gap and the two tap areas be
// checked together (vr1, 2026-09-16).

import { COMPACT_CONTROL_FRAME_DP, COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/touch-target';

/**
 * The pill's hit slop: vertical only, plus a 2pt horizontal cap so it cannot
 * reach into the neighboring overflow button's expanded hit area.
 */
export const FIX_WITH_KILO_HIT_SLOP = { top: 10, bottom: 10, left: 2, right: 2 } as const;

/** The overflow's frame: `h-11 w-11` measured on device. */
export const COMMENT_ACTIONS_FRAME_DP = COMPACT_CONTROL_FRAME_DP;

/** The overflow's visible circle, in explicit dp so rem cannot shrink it. */
export const COMMENT_ACTIONS_VISUAL_DP = 28;

/** The overflow's hit slop, which lifts its frame to the 44pt minimum. */
export const COMMENT_ACTIONS_HIT_SLOP = {
  top: COMPACT_CONTROL_HIT_SLOP_DP,
  bottom: COMPACT_CONTROL_HIT_SLOP_DP,
  left: COMPACT_CONTROL_HIT_SLOP_DP,
  right: COMPACT_CONTROL_HIT_SLOP_DP,
} as const;

/** The trailing group's `gap-3` class, in dp: 0.75rem at NativeWind's 14pt rem. */
export const COMMENT_TRAILING_CONTROLS_GAP_DP = 10.5;

/**
 * Horizontal dp between the pill's expanded right edge and the overflow's
 * expanded left edge: the gap between the two frames less each control's slop
 * on the facing side. The overflow's frame is wider than its visible circle,
 * but the gap and both slops are measured from the frame, so the frame's inset
 * does not enter here. A positive value means the two tap areas never overlap,
 * so each control keeps every tap that lands on it.
 */
export function commentTrailingControlsClearanceDp(): number {
  return (
    COMMENT_TRAILING_CONTROLS_GAP_DP - FIX_WITH_KILO_HIT_SLOP.right - COMMENT_ACTIONS_HIT_SLOP.left
  );
}
