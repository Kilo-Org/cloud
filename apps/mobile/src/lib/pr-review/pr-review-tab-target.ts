// Tap-area geometry for the PR review tab row's Overview / Files / Discussion
// pills. A control-size audit reads the frame a control renders, and this frame
// is short of the design target: `py-2` at NativeWind's 14pt rem plus one
// `text-sm` line renders 31.5pt, measured 31.6dp on the emulator. `hitSlop`
// carries the rest of the target: it widens the touch area only and does not
// move the frame the size audit reads, which is the rule
// `apps/mobile/AGENTS.md` sets for a control thinner than its touch size.
//
// The slop is vertical only: the pills sit `gap-1` (3.5pt) apart, so widening
// each touch area sideways would overlap its neighbour's, and the pill is
// already far wider than the target.

/** The height a tab's `py-2` frame plus one `text-sm` line renders, in dp. */
export const PR_REVIEW_TAB_FRAME_DP = 31.5;

/**
 * Per-side vertical `hitSlop` of a tab: 31.5 + 7 + 7 = 45.5dp, past the 44pt
 * touch target.
 */
export const PR_REVIEW_TAB_HIT_SLOP_DP = 7;

/** The `hitSlop` a tab pressable renders, as {@link PR_REVIEW_TAB_HIT_SLOP_DP}. */
export const PR_REVIEW_TAB_HIT_SLOP = {
  top: PR_REVIEW_TAB_HIT_SLOP_DP,
  bottom: PR_REVIEW_TAB_HIT_SLOP_DP,
} as const;
