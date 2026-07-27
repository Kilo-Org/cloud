// Pure touch-target helpers for the PR diff surface.
//
// Diff rows are rendered contiguously with zero vertical gaps, so vertical
// hit-slop expansion would overlap adjacent rows and mis-route taps. We keep
// horizontal padding only and rely on the bounded row height itself for the
// vertical target.

/** Horizontal padding applied to the pressable row so a narrow split-view
 *  or side-by-side column still exposes a wider touchable target. */
const MIN_TOUCH_HORIZONTAL_PAD = 8;

/**
 * Horizontal-only hit slop for a diff row.
 *
 * The diff list renders rows back-to-back with zero vertical gaps, so
 * expanding the touchable vertically would overlap the neighbouring row
 * and mis-route taps (the lower sibling wins hit-tests in React Native).
 * Per-row selection accuracy and diff density take precedence over a
 * nominal 44pt vertical target on contiguous rows. The row is already fully
 * tappable edge-to-edge, and its height grows with the user's bounded
 * accessibility font scale.
 *
 * We keep purely horizontal padding so narrow split-view / side-by-side
 * columns still expose a wider touchable target than the visible row alone.
 *
 * Pure: depends only on constants, so it is testable in plain Node.
 */
export function hitSlopForRow() {
  return {
    left: MIN_TOUCH_HORIZONTAL_PAD,
    right: MIN_TOUCH_HORIZONTAL_PAD,
  };
}
