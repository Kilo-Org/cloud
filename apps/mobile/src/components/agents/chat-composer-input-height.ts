/**
 * Shared "scrollable at max height" threshold for the agents chat composer.
 * Mirror-Text (`useTextHeight`) owns growth measurement; this module keeps the
 * gate used by the row's `scrollEnabled` and the composer's swipe-down pan.
 */

/** Mirrors the input row's own geometry: `paddingHorizontal` on the TextInput. */
export const COMPOSER_INPUT_PADDING_HORIZONTAL = 16;
/** … and the 1px `border` on the wrapper View that `onLayout` measures. */
const COMPOSER_INPUT_BORDER_WIDTH = 1;

/**
 * Screen chrome above the composer that the remaining-space cap must not eat:
 * the `ScreenHeader` (back-button row ~44 + padding ~20) plus a deliberately
 * conservative allowance shared with the new-session prompt. The allowance is
 * generous on purpose: scrolling the input earlier can never push the composer
 * off screen, so the shared value is kept at 92 and the top inset is subtracted
 * separately by the cap.
 */
export const SESSION_HEADER_HEIGHT = 92;

/**
 * Starter chips: the empty session shows four chips that wrap to two rows.
 * Budget two rows of ~48 min height each plus the 8px gap and 8px bottom
 * padding (112). Kept out of the input's remaining-space budget so the input
 * stays clear of the keyboard with starters shown.
 */
export const STARTER_ROW_HEIGHT = 112;

/**
 * Composer chrome other than the input itself, kept out of the input's
 * remaining-space budget: the control-row padding (20), the toolbar (44), the
 * counter (16), the starter rows (112), and a reserve for the attachment strip
 * (40). Conservative so the input stays clear of the keyboard at every Dynamic
 * Type scale.
 */
export const COMPOSER_CHROME_HEIGHT = 120 + STARTER_ROW_HEIGHT;

/**
 * New-session prompt chrome other than the input: the control row + toolbar +
 * attachment strip + Start button + starter row. The prompt lives in a
 * scrollable form, so the cap is a soft bound that keeps the input from
 * pushing the Start control off-screen at large text.
 */
export const NEW_SESSION_PROMPT_CHROME_HEIGHT = 176 + STARTER_ROW_HEIGHT;

/**
 * New-session prompt card chrome the input must never squeeze out: the form's
 * `pt-4` (16), the card's `pt-2` (8), the control row (44), and the toolbar
 * (57). The mode and model pills are the last of these rows, so they are what
 * the keyboard clips first when the space above the IME is short. Kept apart
 * from `NEW_SESSION_PROMPT_CHROME_HEIGHT`, which is a soft cap that also
 * reserves the starter row; the min-height floor guards only the rows the input
 * must not push off screen.
 */
export const NEW_SESSION_PROMPT_CARD_CHROME_HEIGHT = 125;

/**
 * The card rows whose height does not change with the system font scale: the
 * form's `pt-4` (16), the card's `pt-2` (8), the control row (44), and the
 * toolbar's border plus padding (37).
 */
export const NEW_SESSION_PROMPT_CARD_CHROME_FIXED_HEIGHT = 105;

/** The one row that does scale: the mode/model pill's `text-sm` line. */
export const NEW_SESSION_PROMPT_CARD_CHROME_TEXT_HEIGHT = 20;

/**
 * The always-present card rows above the toolbar, none of which changes with
 * the system font scale: the form's `pt-4` (16), the card's `pt-2` (8), and
 * the control row (44). The rows that render only in some states are added by
 * `resolveNewSessionPromptCardChromeRowsAboveToolbar`. The toolbar itself is
 * measured on layout — its mode/model pills wrap onto a second row on narrow
 * viewports, so its height is not a constant — and
 * `resolveNewSessionPromptCardChromeHeight` stays only as the first-frame
 * fallback for the measured value.
 */
export const NEW_SESSION_PROMPT_CARD_CHROME_ROWS_ABOVE_TOOLBAR = 68;

/**
 * The attachment strip above the input: its `mb-2` (8) plus the tallest chip,
 * the image's `h-16` (64). It renders only while an attachment is staged, so
 * the floor must reserve it conditionally — without it the input keeps a line
 * the strip takes and the toolbar's pills drop toward the keyboard.
 */
export const NEW_SESSION_PROMPT_CARD_CHROME_ATTACHMENT_STRIP_HEIGHT = 72;

/**
 * The metadata-strip failure notice above the input: its `mb-2` (8) plus one
 * `text-xs` line (16). It renders only after a failed strip, so the floor
 * reserves it conditionally like the attachment strip.
 */
export const NEW_SESSION_PROMPT_CARD_CHROME_ATTACHMENT_STATUS_HEIGHT = 24;

/**
 * The near-limit character counter between the input and the control row: its
 * `pb-1` (4) plus one `text-xs` line (16). It renders only near the prompt
 * limit, so the floor reserves it conditionally too.
 */
export const NEW_SESSION_PROMPT_CARD_CHROME_COUNTER_HEIGHT = 20;

/**
 * The card rows above the toolbar, including the ones that render only in some
 * states: the fixed rows plus the attachment strip while attachments are
 * staged, the metadata-strip failure notice, and the counter near the prompt
 * limit. Every row the input's floor does not reserve is a line the input keeps
 * while the row that needs the space drops under the keyboard.
 */
export function resolveNewSessionPromptCardChromeRowsAboveToolbar(options: {
  hasAttachments: boolean;
  showsAttachmentStatus: boolean;
  showsCounter: boolean;
}): number {
  return (
    NEW_SESSION_PROMPT_CARD_CHROME_ROWS_ABOVE_TOOLBAR +
    (options.hasAttachments ? NEW_SESSION_PROMPT_CARD_CHROME_ATTACHMENT_STRIP_HEIGHT : 0) +
    (options.showsAttachmentStatus ? NEW_SESSION_PROMPT_CARD_CHROME_ATTACHMENT_STATUS_HEIGHT : 0) +
    (options.showsCounter ? NEW_SESSION_PROMPT_CARD_CHROME_COUNTER_HEIGHT : 0)
  );
}

/**
 * Card chrome budget from the measured toolbar height and the rows above it.
 * At the unwrapped toolbar's 57 (`border-t` 1 + `py-3` 24 + pill row 32) this
 * equals the shipped fontScale-1 budget; a wrapped toolbar measures ~97 and
 * reserves its second pill row so the keyboard cannot cut it.
 */
export function resolveNewSessionPromptCardChromeHeightFromToolbar(
  toolbarHeight: number,
  rowsAboveToolbarHeight: number = NEW_SESSION_PROMPT_CARD_CHROME_ROWS_ABOVE_TOOLBAR
): number {
  return rowsAboveToolbarHeight + toolbarHeight;
}

/**
 * The new-session card chrome budget: the rows above the toolbar plus the
 * measured toolbar height once the toolbar has laid out (its pills wrap on
 * narrow viewports, so it is not a constant), or the static fontScale budget
 * before that first layout.
 *
 * A missing or non-positive toolbar height means "not measured": the static
 * budget stands in rather than the rows above the toolbar alone (68), which
 * sits below the static estimate (125) and makes the input keep lines the card
 * cannot fit. `toolbarRendered: false` is the same case — the models-error
 * block renders in the toolbar's place, so there is no toolbar to measure.
 */
export function resolveNewSessionPromptCardChrome(options: {
  fontScale: number;
  toolbarHeight: number | null;
  rowsAboveToolbarHeight?: number;
  toolbarRendered?: boolean;
}): number {
  const rowsAboveToolbarHeight =
    options.rowsAboveToolbarHeight ?? NEW_SESSION_PROMPT_CARD_CHROME_ROWS_ABOVE_TOOLBAR;
  const conditionalRows =
    rowsAboveToolbarHeight - NEW_SESSION_PROMPT_CARD_CHROME_ROWS_ABOVE_TOOLBAR;
  const measuredToolbarHeight =
    options.toolbarRendered === false ||
    options.toolbarHeight === null ||
    options.toolbarHeight <= 0
      ? null
      : options.toolbarHeight;
  // The static budget already covers the fixed rows, so the conditional rows
  // are added on top of it.
  return measuredToolbarHeight === null
    ? resolveNewSessionPromptCardChromeHeight(options.fontScale) + conditionalRows
    : resolveNewSessionPromptCardChromeHeightFromToolbar(
        measuredToolbarHeight,
        rowsAboveToolbarHeight
      );
}

/**
 * The card chrome budget at a system font scale: only the pill's text line
 * grows with `fontScale`; every other row above is fixed. The budget feeds the
 * input's min-height floor, so multiplying the fixed rows by `fontScale` too
 * over-reserves and makes the input give up lines the card has room for.
 *
 * `resolveNewSessionPromptCardChromeHeight(1)` equals
 * `NEW_SESSION_PROMPT_CARD_CHROME_HEIGHT` (125) on purpose: the reported
 * density-560 viewport must keep exactly the result the fontScale-1 budget
 * produces.
 */
export function resolveNewSessionPromptCardChromeHeight(fontScale: number): number {
  return (
    NEW_SESSION_PROMPT_CARD_CHROME_FIXED_HEIGHT +
    NEW_SESSION_PROMPT_CARD_CHROME_TEXT_HEIGHT * fontScale
  );
}

/**
 * Width of the real text area inside the composer input row.
 *
 * `onLayout` reports the wrapper's border box, so both the wrapper border and
 * the TextInput's horizontal padding come off. Measuring even 1px wider makes
 * the mirror Text fit a word the real input wraps, which renders the input one
 * line short with `scrollEnabled` still false — the clipped word is then
 * unreachable.
 */
export function resolveComposerTextContentWidth(wrapperWidth: number): number {
  return wrapperWidth - (COMPOSER_INPUT_PADDING_HORIZONTAL + COMPOSER_INPUT_BORDER_WIDTH) * 2;
}

export function shouldEnableComposerInputScroll(height: number, maxHeight: number): boolean {
  return height >= maxHeight;
}

/**
 * Hard cap for the agent chat composer input, in unscaled points.
 *
 * The remaining-space cap alone lets the input fill a tall window (and the
 * whole space above the keyboard on a tablet), which pushes the transcript off
 * screen. The input scrolls past this height instead of growing further.
 */
export const COMPOSER_INPUT_MAX_HEIGHT = 124;

/**
 * Hard cap for the new-session prompt input, in unscaled points. Larger than
 * the chat composer cap: the prompt form has no transcript to protect and the
 * first task can be several lines.
 */
export const NEW_SESSION_PROMPT_INPUT_MAX_HEIGHT = 160;

/**
 * Remaining-space cap for the composer input, bounded by an absolute cap. The
 * input may grow only into the space left after the keyboard, the safe areas,
 * the session header, and every other piece of composer chrome (attachment
 * strip, send/stop, mic, newline control, starters, counter) are subtracted
 * from the window height, and never past `absoluteMaxHeight`. The result is
 * floored at `minHeight` so a single-line input is always readable, and a
 * degenerate window (keyboard + chrome exceeding the window) can never return
 * a negative height.
 */
export function resolveComposerMaxHeight({
  windowHeight,
  safeAreaInsetTop,
  safeAreaInsetBottom,
  keyboardHeight,
  sessionHeaderHeight,
  composerChromeHeight,
  minHeight,
  absoluteMaxHeight,
}: {
  windowHeight: number;
  safeAreaInsetTop: number;
  safeAreaInsetBottom: number;
  keyboardHeight: number;
  sessionHeaderHeight: number;
  composerChromeHeight: number;
  minHeight: number;
  absoluteMaxHeight: number;
}): number {
  const remaining =
    windowHeight -
    safeAreaInsetTop -
    safeAreaInsetBottom -
    keyboardHeight -
    sessionHeaderHeight -
    composerChromeHeight;
  return Math.max(minHeight, Math.min(Math.floor(remaining), absoluteMaxHeight));
}

/**
 * Clearance the measured-viewport floor keeps between the card's last row (the
 * mode/model toolbar) and the frame's bottom edge, in unscaled points. The
 * frame's bottom edge is the keyboard's top edge while the IME is up, and the
 * pills must clear it whole: half a text line is enough that a device whose
 * frame lands a few points short of a second line still keeps the single line
 * the pills need, and small enough that the input still takes the line back
 * when the IME withdraws.
 */
const COMPOSER_VIEWPORT_FLOOR_CLEARANCE = 12;

/**
 * Remaining-space floor measured against the viewport the composer actually
 * scrolls in, instead of against the window minus a guessed header.
 *
 * `resolveComposerMinHeight` subtracts the window's safe-area insets, the
 * keyboard, and the session header from the whole window. The frame the
 * composer lives in has already had all three taken out of it — the header is
 * a sibling above the scroll frame, and the IME padding shrinks the frame — so
 * the window subtraction double-counts them. On the short landscape viewport
 * that under-count is a whole line: the input stayed at one line after the
 * keyboard withdrew, while the frame had grown by 24dp (e7, 2026-09-21).
 *
 * Measured against the frame, the floor rises and falls with the keyboard by
 * construction: with the IME up the frame is short and the input keeps the
 * single line the pills need; when the IME withdraws the frame grows back and
 * the input grows back with it, up to `defaultLines`.
 */
export function resolveComposerMinHeightForViewport({
  viewportHeight,
  composerChromeHeight,
  lineHeight,
  verticalPadding,
  defaultLines,
  minLines = 1,
}: {
  viewportHeight: number;
  composerChromeHeight: number;
  lineHeight: number;
  verticalPadding: number;
  defaultLines: number;
  minLines?: number;
}): number {
  const available = viewportHeight - composerChromeHeight - COMPOSER_VIEWPORT_FLOOR_CLEARANCE;
  const lines = Math.floor((available - verticalPadding) / lineHeight);
  const bounded = Math.min(Math.max(lines, minLines), defaultLines);
  return bounded * lineHeight + verticalPadding;
}

/**
 * Remaining-space floor for the composer input: the counterpart of the max cap.
 * The max bounds how tall the input may GROW; this bounds how tall it may
 * INSIST on being. It subtracts the same terms as `resolveComposerMaxHeight`
 * (keyboard, safe areas, session header, composer chrome) and snaps the
 * leftover to whole lines, clamped between `minLines` and `defaultLines`. The
 * input then gives up lines before the card's control row and its mode/model
 * toolbar are clipped by the keyboard. The result is never negative and never
 * below `minLines` whole lines, so a degenerate window still renders a readable
 * input.
 */
export function resolveComposerMinHeight({
  windowHeight,
  safeAreaInsetTop,
  safeAreaInsetBottom,
  keyboardHeight,
  sessionHeaderHeight,
  composerChromeHeight,
  lineHeight,
  verticalPadding,
  defaultLines,
  minLines = 1,
}: {
  windowHeight: number;
  safeAreaInsetTop: number;
  safeAreaInsetBottom: number;
  keyboardHeight: number;
  sessionHeaderHeight: number;
  composerChromeHeight: number;
  lineHeight: number;
  verticalPadding: number;
  defaultLines: number;
  minLines?: number;
}): number {
  const available =
    windowHeight -
    safeAreaInsetTop -
    safeAreaInsetBottom -
    keyboardHeight -
    sessionHeaderHeight -
    composerChromeHeight;
  const lines = Math.floor((available - verticalPadding) / lineHeight);
  const bounded = Math.min(Math.max(lines, minLines), defaultLines);
  return bounded * lineHeight + verticalPadding;
}
