/**
 * How the New Session form lays out the sections above the repository picker on
 * a short window.
 *
 * The form's first screenful has to reach the picker, because Start needs a
 * repository: on a 360x640 dp window the composer's three-line floor plus the
 * stacked `Account` and `Run on` headings ended the screenful on the
 * `Repository` heading, and the picker itself sat 43.8 dp under the pinned
 * Start footer — visible as a label over empty space, with no control to open.
 *
 * A heading beside its control instead of above it costs its row nothing, and
 * the two sections give the picker 49 dp, which clears the footer at that size.
 * The composer keeps its floor and the form keeps its order, so nothing has to
 * re-measure: the decision reads the window, which is known before the first
 * layout, and a form whose sections moved after a measured frame settled would
 * shift every row below the card a second time.
 *
 * The height threshold is the last window that still needs the compact row: the
 * composer's floor (88), the card's top gap and chrome (14 + 125) and the rows
 * under it (262) need a 489 dp form frame, and the screen chrome around that
 * frame measures ~218 dp at this size. It is a height rule, not a portrait
 * rule: a landscape phone (~360-411 dp tall) and a 1024x600 landscape tablet
 * are short too and take the row, and only a window taller than the threshold
 * keeps the stacked heading.
 *
 * The width rule measures the room the heading itself gets, in points of text.
 * The heading takes at most `NEW_SESSION_SECTION_LABEL_WIDTH_RATIO` of the row,
 * and a word of the longest localized name needs about 144 dp at the base text
 * size; a system font scale multiplies the word and not the share. A window
 * whose label share still holds that word keeps the row — a 360 dp phone does
 * up to scale 1.125 — and everything narrower or larger-scaled keeps the
 * stacked form and scrolls the picker into view. An unknown width, height or
 * scale keeps the stacked form for the same reason: the compact row is the
 * exception, never the default.
 */
const NEW_SESSION_INLINE_SECTION_MAX_WINDOW_HEIGHT = 720;

/** The largest share of its row the inline heading may take. */
export const NEW_SESSION_SECTION_LABEL_WIDTH_RATIO = 0.45;

/**
 * Room one word of the longest localized heading needs, in points at the base
 * text size. `narrow-layout` draws its equivalent line at 240 dp of row for a
 * row with fixed neighbours; here the share is capped, so the comparison is
 * made against the share itself.
 */
const NEW_SESSION_SECTION_LABEL_MIN_TEXT_WIDTH = 144;

export function resolveNewSessionInlineSections(
  windowWidth: number,
  windowHeight: number,
  fontScale: number
): boolean {
  if (
    !Number.isFinite(windowWidth) ||
    !Number.isFinite(windowHeight) ||
    !Number.isFinite(fontScale) ||
    fontScale <= 0 ||
    windowHeight <= 0
  ) {
    return false;
  }
  const labelRoom = (windowWidth * NEW_SESSION_SECTION_LABEL_WIDTH_RATIO) / fontScale;
  return (
    labelRoom >= NEW_SESSION_SECTION_LABEL_MIN_TEXT_WIDTH &&
    windowHeight < NEW_SESSION_INLINE_SECTION_MAX_WINDOW_HEIGHT
  );
}
