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
