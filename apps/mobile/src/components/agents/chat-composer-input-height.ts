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
 * the `ScreenHeader` (back-button row ~44 + padding ~20) and the
 * `SessionConnectionIndicator` (~28), excluding the safe-area top inset which
 * the cap subtracts separately.
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
