export const PR_DIFF_LIST_FOOTER_GAP = 12;
export const PR_DIFF_FLOATING_ACTIONS_FALLBACK_HEIGHT = 108;

/**
 * Returns the bottom padding for the diff FlashList so the last item clears
 * the floating action bar.
 *
 * When the bar height is unknown, zero, or negative the function returns
 * `FALLBACK_HEIGHT + GAP`.  Otherwise it returns the rounded height plus
 * the gap.
 */
export function prDiffListBottomPadding(floatingActionsHeight: number | null): number {
  if (floatingActionsHeight === null || floatingActionsHeight <= 0) {
    return PR_DIFF_FLOATING_ACTIONS_FALLBACK_HEIGHT + PR_DIFF_LIST_FOOTER_GAP;
  }
  return Math.round(floatingActionsHeight) + PR_DIFF_LIST_FOOTER_GAP;
}
