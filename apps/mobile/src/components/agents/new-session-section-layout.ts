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
 * the row is the window less the form content's horizontal padding
 * (`NEW_SESSION_SECTION_ROW_INSET`), and a word of the longest localized name
 * needs about 144 dp at the base text size; a system font scale multiplies the
 * word and not the share. A window whose label share still holds that word
 * keeps the row — the 360 dp compact cell does at the base scale, and its share
 * runs out just above it — and everything narrower or larger-scaled keeps the
 * stacked form and scrolls the picker into view. An unknown width, height or
 * scale keeps the stacked form for the same reason: the compact row is the
 * exception, never the default.
 *
 * The inset is the form's own `px-4`, 14 dp per side at NativeWind's rem: the
 * 360 dp compact cell measures a 331.81 dp row. A landscape window also loses
 * its safe-area side insets, which this does not subtract — the row there is
 * over 850 dp, so the share stays far above the word's need.
 */
const NEW_SESSION_INLINE_SECTION_MAX_WINDOW_HEIGHT = 720;

/** The largest share of its row the inline heading may take. */
export const NEW_SESSION_SECTION_LABEL_WIDTH_RATIO = 0.45;

/** Horizontal padding the form puts between the window edge and the row. */
const NEW_SESSION_SECTION_ROW_INSET = 28;

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
  const rowWidth = windowWidth - NEW_SESSION_SECTION_ROW_INSET;
  const labelRoom = (rowWidth * NEW_SESSION_SECTION_LABEL_WIDTH_RATIO) / fontScale;
  return (
    labelRoom >= NEW_SESSION_SECTION_LABEL_MIN_TEXT_WIDTH &&
    windowHeight < NEW_SESSION_INLINE_SECTION_MAX_WINDOW_HEIGHT
  );
}
