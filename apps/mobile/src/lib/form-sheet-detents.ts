type SheetPlatform = 'android' | 'ios' | 'macos' | 'windows' | 'web';

/**
 * The shortest window that can still present an organization form sheet at its
 * half detent.
 *
 * A formSheet's content is laid out against the full stack height, so whatever
 * does not fit the presented detent is clipped, not scrolled. A landscape window
 * is shorter than twice the tallest organization form plus the tab bar it has to
 * stay above (the band alone is 78pt with an Android safe-area inset), so the
 * half detent would put the form's last row and its submit action under the bar
 * with no way to reach them. Windows in this range open these sheets at the full
 * detent instead, where the shared sheet scroll view keeps the content above the
 * bar.
 */
const ORG_SHEET_HALF_DETENT_MIN_WINDOW_HEIGHT = 840;

/**
 * The shortest window that can still show a searchable picker at its half
 * detent with one result row under the pinned header.
 *
 * The pinned header (title row plus search field) is about 126pt, and a picker
 * row is 46-54pt, so a sheet needs roughly 200pt of presented body. iOS sizes
 * the half detent at a fraction of the window (measured 202pt in a 486pt
 * window and 213pt in a 501pt window), and a short window leaves less than one
 * row. Under that height the picker moves its search field into the scrolling
 * list, so the rows stay reachable however little the window and the keyboard
 * leave.
 */
const SEARCH_PICKER_PINNED_HEADER_MIN_WINDOW_HEIGHT = 600;

/**
 * Whether a searchable picker must render its search field as list content
 * instead of pinning it in the sheet header. Only the window height decides:
 * the sheet's presented height is derived from it, and the shell has no
 * measurement of that height.
 */
export function searchPickerHeaderInList({ windowHeight }: { windowHeight: number }): boolean {
  return windowHeight < SEARCH_PICKER_PINNED_HEADER_MIN_WINDOW_HEIGHT;
}

/**
 * Detents for the organization form sheets: `[half, full]` in a window tall
 * enough to show the form at the half detent, the full detent alone otherwise.
 * iOS form sheets own their own insets, so they keep both.
 */
export function organizationSheetDetents({
  platform,
  windowHeight,
  fullSheetDetent,
}: {
  platform: SheetPlatform;
  windowHeight: number;
  fullSheetDetent: number;
}): [number, number] | [number] {
  if (platform === 'android' && windowHeight < ORG_SHEET_HALF_DETENT_MIN_WINDOW_HEIGHT) {
    return [fullSheetDetent];
  }
  return [0.5, fullSheetDetent];
}
