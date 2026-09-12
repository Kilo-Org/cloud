export const PR_DIFF_LIST_FOOTER_GAP = 12;

/**
 * Returns the content-container padding for the diff FlashList: the fixed
 * gap between the last row and the in-flow footer bar, plus the landscape
 * side insets that keep rows clear of the sensor housing.
 *
 * The bar is an in-flow footer below the list (spot check e3: it used to sit
 * `absolute inset-x-0 bottom-0` and clip the last partly-scrolled row), so
 * the list reserves no bar height — only the gap. The side insets are
 * horizontal-only, so the height-feeding bottom padding is untouched.
 */
export function prDiffListContentPadding(
  _floatingActionsHeight: number | null,
  insets: { left: number; right: number }
) {
  return {
    paddingBottom: PR_DIFF_LIST_FOOTER_GAP,
    paddingLeft: insets.left,
    paddingRight: insets.right,
  };
}
