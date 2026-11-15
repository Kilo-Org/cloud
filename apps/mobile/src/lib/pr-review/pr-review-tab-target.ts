// Tap-area geometry for the PR review tab row's Overview / Files / Discussion
// pills. A control-size audit reads the frame a control renders, and this frame
// is short of the design target: `py-2` at NativeWind's 14pt rem plus one
// `text-sm` line works out to 31.5dp, and the design gate measures 32.4dp on
// the emulator once the platform rounds the text line. `hitSlop` carries the
// rest of the target: it widens the touch area only and does not move the frame
// the size audit reads, which is the rule `apps/mobile/AGENTS.md` sets for a
// control thinner than its touch size.
//
// The slop is vertical only: the pills sit `gap-1` (3.5pt) apart, so widening
// each touch area sideways would overlap its neighbour's, and the pill is
// already far wider than the target.
//
// The row's own `p-1` is 3.5dp, so part of this slop lies outside the row's
// bounds. That is delivery, not geometry, and Android delivers it: measured on
// the emulator, a tap 5.7dp above a pill still switched tabs, while a tap 8.8dp
// above — past the 7dp slop — did not.

/** The height a tab's `py-2` frame plus one `text-sm` line renders, in dp. */
export const PR_REVIEW_TAB_FRAME_DP = 31.5;

/**
 * Per-side vertical `hitSlop` of a tab: 31.5 + 7 + 7 = 45.5dp of touch area, and
 * 32.4 + 7 + 7 = 46.4dp at the height the gate measures, past the 44pt target.
 */
export const PR_REVIEW_TAB_HIT_SLOP_DP = 7;

/** The `hitSlop` a tab pressable renders, as {@link PR_REVIEW_TAB_HIT_SLOP_DP}. */
export const PR_REVIEW_TAB_HIT_SLOP = {
  top: PR_REVIEW_TAB_HIT_SLOP_DP,
  bottom: PR_REVIEW_TAB_HIT_SLOP_DP,
} as const;
