/**
 * Bottom-chrome geometry for the live Agents list.
 *
 * The tab bar and the FAB are absolutely-positioned overlays, so the list
 * viewport must clear them. In a tall window the whole band
 * (`tabBarHeight + fabBand`) is reserved as the list frame's `marginBottom`
 * and nothing is pushed onto the list content. In a short window (the Android
 * landscape capture is 420dp tall) reserving the whole band left the frame
 * only 61dp while one row needs a whole pitch, so the first card was cut
 * mid-glyph at the list's lower edge while the FAB band stayed blank. This
 * module hands the reserve back as far as one row pitch needs.
 *
 * The tab bar is a hard clearance: it is never yielded, because rows under it
 * would be unreachable. The FAB band is soft — the button is a 56dp corner
 * overlay — and yields only as far as one row pitch needs. The yielded part
 * rides on the list's *content* (`paddingBottom`) so the last row can still be
 * scrolled clear of the button, and never on the frame: a scroll view's frame
 * padding is not part of its scrollable content on iOS, so padding there
 * clipped the last rows under the bar with no way to scroll them clear (see
 * the comment on the list insets in `session-list-screen.tsx`). The accepted
 * trade is that in a short window rows scrolled into the band can pass under
 * the button — better than clipping the first row at rest.
 */

/**
 * One live list row's pitch. The loading skeleton is `h-[76px]` inside a
 * `py-1.5` row (12dp), and the real row (72dp measured on the device capture)
 * fits inside that box, so the skeleton is the binding size.
 */
export const SESSION_ROW_PITCH = 88;

type AgentsListBottomInsetInput = {
  /** Measured height of the list's body wrapper; `null` before the first layout. */
  available: number | null;
  tabBarHeight: number;
  /** Height of the FAB band (`FAB_SIZE + FAB_MARGIN`), or 0 when no FAB shows. */
  fabBand: number;
  minViewport?: number;
};

/** How the bottom band splits between the list frame and the list content. */
export type AgentsListBottomInset = { frame: number; content: number };

/**
 * Split the bottom band into the part the list frame reserves (`frame`) and the
 * part that rides on the list content (`content`). `frame + content` always
 * equals `tabBarHeight + fabBand`, so no space is lost or duplicated.
 */
export function getAgentsListBottomInset({
  available,
  tabBarHeight,
  fabBand,
  minViewport = SESSION_ROW_PITCH,
}: AgentsListBottomInsetInput): AgentsListBottomInset {
  const fullBand = tabBarHeight + fabBand;
  // The first, unmeasured frame keeps today's geometry exactly: the whole band
  // on the frame, nothing on the content.
  if (available === null) {
    return { frame: fullBand, content: 0 };
  }
  const frame = Math.min(fullBand, Math.max(tabBarHeight, available - minViewport));
  return { frame, content: fullBand - frame };
}
