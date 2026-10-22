// Tap-area geometry for the trailing controls of one review-comment row: the
// "Fix with Kilo" pill and the overflow (moderation) button beside it.
//
// Both controls are compact, and their tap area is bigger than their visual: a
// control-size audit measures the frame a control renders, so the overflow's
// frame is the shared 48dp icon target (`ICON_TARGET_BOX_CLASS`) around a
// 28pt visible circle — Android's minimum, measured on the node's own rect.
// The pill renders only 23pt tall at that same rem, so its own vertical slop,
// not its frame, is what reaches the minimum. The pill's expanded right edge
// and the overflow's expanded left edge must never meet: a tap on the pill —
// including its right edge — must open the session, never the moderation
// sheet. The row keeps the literal classes and the slop objects below;
// `comment-trailing-controls.test.ts` reads the row's source and these two
// slop objects together so the gap and the two tap areas are checked against
// what the row actually renders (vr1, 2026-09-16).

import { COMPACT_H11_HIT_SLOP_DP, ICON_TARGET_DP } from '@/lib/a11y/tap-target';

/**
 * The pill's visual height in pt, read off its classes in
 * `pr-comment-fix-with-kilo.tsx`: `text-xs` sets a 1rem line box — 14pt at
 * NativeWind's rem — `py-1` adds 0.25rem (3.5pt) per side, and the top and
 * bottom border add 1pt each. The `WandSparkles size={14}` icon is no taller
 * than that line box, so the pill renders 14 + 7 + 2 = 23pt. A 16pt rem would
 * give 26pt, which is what the pre-audit figures assumed.
 */
export const FIX_WITH_KILO_VISUAL_DP = 23;

/**
 * The pill's hit slop: vertical only, plus a 2pt horizontal cap so it cannot
 * reach into the neighboring overflow button's expanded hit area. The vertical
 * slop is 11pt per side, not 10: at 10 the 23pt pill reaches 43pt, 1pt short of
 * the 44pt minimum, while 23 + 11 + 11 = 45 clears it.
 */
export const FIX_WITH_KILO_HIT_SLOP = { top: 11, bottom: 11, left: 2, right: 2 } as const;

/** The overflow's frame: the shared 48dp icon target, measured on device. */
export const COMMENT_ACTIONS_FRAME_DP = ICON_TARGET_DP;

/** The overflow's visible circle, in explicit dp so rem cannot shrink it. */
export const COMMENT_ACTIONS_VISUAL_DP = 28;

/**
 * The overflow's hit slop. The 48dp frame alone meets Android's minimum; the
 * slop only extends the reach and is capped on the pill's side by the gap
 * arithmetic the test guards.
 */
export const COMMENT_ACTIONS_HIT_SLOP = {
  top: COMPACT_H11_HIT_SLOP_DP,
  bottom: COMPACT_H11_HIT_SLOP_DP,
  left: COMPACT_H11_HIT_SLOP_DP,
  right: COMPACT_H11_HIT_SLOP_DP,
} as const;

/** The trailing group's `gap-3` class, in dp: 0.75rem at NativeWind's 14pt rem. */
export const COMMENT_TRAILING_CONTROLS_GAP_DP = 10.5;
