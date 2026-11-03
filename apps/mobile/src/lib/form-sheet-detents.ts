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
