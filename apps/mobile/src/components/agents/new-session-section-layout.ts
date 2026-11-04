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
 * The width gate is judged in points of text, not of screen: the heading shares
 * its row with the control at most 45% of the width, so the room a word has is
 * `windowWidth / fontScale`. Below the narrowest common phone (320 dp) — and at
 * any system font scale that shrinks that room below it — a long localized name
 * no longer fits one word and would break mid-word, the defect `narrow-layout`
 * documents. Those windows keep the stacked layout and scroll the picker into
 * view. An unknown width, height or scale keeps the stacked form for the same
 * reason: the compact row is the exception, never the default.
 */
const NEW_SESSION_INLINE_SECTION_MAX_WINDOW_HEIGHT = 720;
const NEW_SESSION_INLINE_SECTION_MIN_TEXT_WIDTH = 320;

export function resolveNewSessionInlineSections(
  windowWidth: number,
  windowHeight: number,
  fontScale: number
): boolean {
  return (
    Number.isFinite(windowWidth) &&
    Number.isFinite(fontScale) &&
    fontScale > 0 &&
    windowWidth / fontScale >= NEW_SESSION_INLINE_SECTION_MIN_TEXT_WIDTH &&
    Number.isFinite(windowHeight) &&
    windowHeight > 0 &&
    windowHeight < NEW_SESSION_INLINE_SECTION_MAX_WINDOW_HEIGHT
  );
}
