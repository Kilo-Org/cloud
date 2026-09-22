/**
 * Geometry of the bottom chrome the Agents live list must clear: the tab bar
 * (a hard overlay) and the FAB band (a soft 56dp corner overlay).
 *
 * The live list's own row pitch is the skeleton's `h-[76px]` inside a `py-1.5`
 * row (`session-list-screen.tsx`), i.e. 88dp; the real row (72dp measured)
 * fits inside it. In a short window (the 420dp-tall Android landscape window)
 * the full `tabBarHeight + FAB_SIZE + FAB_MARGIN` reserve left the list frame
 * ~59dp while one row is ~72dp, so the first card's branch line was cut at the
 * list's lower edge (device capture `agents-landscape-night`, revision
 * f2181ae79).
 */
export const SESSION_ROW_PITCH = 88;

/**
 * Split the bottom reserve between the list's frame and its content.
 *
 * - The tab bar is a hard clearance and is never yielded: the frame keeps at
 *   least `tabBarHeight`.
 * - The FAB band is soft (the button is a 56dp corner overlay) and is yielded
 *   only as far as one row pitch requires, so at least `minViewport` stays
 *   readable above the band.
 * - The yielded part goes on the list's *content* (`content`), so the last row
 *   can still be scrolled clear of the button. It must never go on the frame:
 *   a frame padding is not scrollable on iOS, so it would clip the last rows
 *   under the bar (see the comment at `use-agents-list-chrome.ts`'s
 *   `listInsets`).
 *
 * `available === null` is the first, unmeasured frame: the whole reserve rides
 * on the frame, exactly the geometry before the body was measured.
 */
export function getAgentsListBottomInset({
  available,
  tabBarHeight,
  fabBand,
  minViewport = SESSION_ROW_PITCH,
}: {
  available: number | null;
  tabBarHeight: number;
  fabBand: number;
  minViewport?: number;
}) {
  if (available === null) {
    return { frame: tabBarHeight + fabBand, content: 0 };
  }
  const frame = Math.min(tabBarHeight + fabBand, Math.max(tabBarHeight, available - minViewport));
  return { frame, content: tabBarHeight + fabBand - frame };
}

/**
 * The full empty-state presentation's height: the icon bubble (56dp), the
 * block gap (16dp), the title (28dp), the title-to-description gap (4dp), the
 * description (20dp), the block gap (16dp) and the 44dp action. The tab bar is
 * a hard overlay, so a clear region shorter than this cannot show the hint and
 * the action above it: the state must render compact (device capture
 * `agents-search-empty`, revision f2181ae79, where the hint and the Clear
 * search action sat behind the bar).
 */
export const EMPTY_STATE_FULL_HEIGHT = 184;

/**
 * Choose the empty state's presentation for the room the body actually keeps.
 *
 * `bottomInset` is the inset the state's `StateSurface` resolves. It is not a
 * hard-coded bar height: the screen's own `StateSurfaceInsets` replaces the
 * inherited reservation (`replaceBottomReservation`) so its centered states
 * keep the bar alone, where the tabs layout reserves the bar plus a 16dp
 * content gap for scrolled content. Measuring the decision against the bar
 * alone while the surface still resolved `tabBarHeight + 16` was 16dp
 * optimistic, and left the compact state running under the bar at the
 * capture's geometry (device capture `agents-search-empty`, revision
 * f2181ae79). The unmeasured first frame (`available === null`) stays full,
 * exactly the geometry before the body was measured.
 */
export function getEmptyStatePresentation({
  available,
  bottomInset,
}: {
  available: number | null;
  bottomInset: number;
}): 'compact' | 'full' {
  return available !== null && available - bottomInset < EMPTY_STATE_FULL_HEIGHT
    ? 'compact'
    : 'full';
}
