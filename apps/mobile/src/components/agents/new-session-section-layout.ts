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
 * The threshold is the last window that still needs the compact row: the
 * composer's floor (88), the card's top gap and chrome (14 + 125) and the rows
 * under it (262) need a 489 dp form frame, and the screen chrome around that
 * frame measures ~218 dp at this size. A taller window keeps the stacked
 * heading it has always had, and a tablet or a landscape window is far above
 * the threshold.
 *
 * An unmeasured window keeps the stacked form: treating an unknown height as
 * short would change the layout on a platform that reports none.
 */
export const NEW_SESSION_INLINE_SECTION_MAX_WINDOW_HEIGHT = 720;

export function resolveNewSessionInlineSections(windowHeight: number): boolean {
  return (
    Number.isFinite(windowHeight) &&
    windowHeight > 0 &&
    windowHeight < NEW_SESSION_INLINE_SECTION_MAX_WINDOW_HEIGHT
  );
}
