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
 * The full empty-state stack's fixed chrome and its `fontScale === 1` text
 * metrics: the icon bubble, a block gap, a `text-lg` title line, the
 * title-to-description gap, a `text-sm` description line per wrapped line, a
 * block gap, and the action's `min-h-[44px]` plus the button's `py-2`.
 */
const EMPTY_STATE_BUBBLE_HEIGHT = 56;
const EMPTY_STATE_BLOCK_GAP = 16;
const EMPTY_STATE_TITLE_LINE_HEIGHT = 28;
const EMPTY_STATE_DESCRIPTION_GAP = 4;
const EMPTY_STATE_DESCRIPTION_LINE_HEIGHT = 20;
const EMPTY_STATE_ACTION_MIN_HEIGHT = 44;
const EMPTY_STATE_ACTION_PADDING = 16;

/**
 * Height the full empty-state presentation needs at `fontScale`. The text parts
 * scale with Dynamic Type: the app renders large text (`Button` uses `min-h`
 * exactly so a scaled label is not clipped, and the tabs layout switches its
 * label wrapping at `fontScale > 1.8`), so the title, the description and the
 * action all grow past their `fontScale === 1` values.
 *
 * The tab bar is a hard overlay, so a clear region shorter than this cannot
 * show the hint and the action above it: the state must render compact (device
 * capture `agents-search-empty`, revision f2181ae79, where the hint and the
 * Clear search action sat behind the bar). A fixed 184dp assumed one line per
 * text block at `fontScale === 1`, so a clear region between it and the state's
 * real height still resolved `full` and left the hint and the action below the
 * bar.
 *
 * `descriptionLines` defaults to 2: the copy the live empty state renders
 * (`agents.sessionList.noSessionsYetDescription`) is longer than one line at
 * phone width, so the state on screen is the two-line one.
 */
export function getEmptyStateFullHeight({
  fontScale = 1,
  descriptionLines = 2,
}: {
  fontScale?: number;
  descriptionLines?: number;
} = {}): number {
  const title = EMPTY_STATE_TITLE_LINE_HEIGHT * fontScale;
  const description = EMPTY_STATE_DESCRIPTION_LINE_HEIGHT * descriptionLines * fontScale;
  // `Button`'s `text-sm` label scales; its `min-h-[44px]` is the floor below
  // that point, and its `py-2` does not scale with the label.
  const action = Math.max(
    EMPTY_STATE_ACTION_MIN_HEIGHT,
    EMPTY_STATE_DESCRIPTION_LINE_HEIGHT * fontScale + EMPTY_STATE_ACTION_PADDING
  );
  return Math.round(
    EMPTY_STATE_BUBBLE_HEIGHT +
      EMPTY_STATE_BLOCK_GAP +
      title +
      EMPTY_STATE_DESCRIPTION_GAP +
      description +
      EMPTY_STATE_BLOCK_GAP +
      action
  );
}

/**
 * Choose the empty state's presentation for the room the body actually keeps.
 *
 * `bottomInset` is the inset the state's `StateSurface` resolves: the tab bar
 * alone while the FAB is hidden, and the bar plus the FAB band while it shows.
 * It is not a hard-coded bar height: the screen's own `StateSurfaceInsets`
 * replaces the inherited reservation (`replaceBottomReservation`) so its
 * centered states keep the bar alone, where the tabs layout reserves the bar
 * plus a 16dp content gap for scrolled content. Measuring the decision against
 * the bar alone while the surface still resolved `tabBarHeight + 16` was 16dp
 * optimistic, and left the compact state running under the bar at the
 * capture's geometry (device capture `agents-search-empty`, revision
 * f2181ae79). The unmeasured first frame (`available === null`) stays full,
 * exactly the geometry before the body was measured, and the height the full
 * state needs is measured at the current `fontScale` (see
 * `getEmptyStateFullHeight`).
 */
export function getEmptyStatePresentation({
  available,
  bottomInset,
  fontScale = 1,
  descriptionLines = 2,
}: {
  available: number | null;
  bottomInset: number;
  fontScale?: number;
  descriptionLines?: number;
}): 'compact' | 'full' {
  return available !== null &&
    available - bottomInset < getEmptyStateFullHeight({ fontScale, descriptionLines })
    ? 'compact'
    : 'full';
}
