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
 * Composer chrome other than the input itself, kept out of the input's
 * remaining-space budget: the control-row padding (20), the toolbar (44), the
 * counter (16), and a reserve for the attachment strip (40). Conservative so
 * the input stays clear of the keyboard at every Dynamic Type scale.
 */
export const COMPOSER_CHROME_HEIGHT = 120;

/**
 * New-session prompt chrome other than the input: the control row + toolbar +
 * attachment strip + Start button. The prompt lives in a scrollable form, so
 * the cap is a soft bound that keeps the input from pushing the Start control
 * off-screen at large text.
 */
export const NEW_SESSION_PROMPT_CHROME_HEIGHT = 176;

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
 * Remaining-space cap for the composer input, replacing the fixed 124/160pt
 * caps. The input may grow only into the space left after the keyboard, the
 * safe areas, the session header, and every other piece of composer chrome
 * (attachment strip, send/stop, mic, newline control, starters, counter) are
 * subtracted from the window height. The result is floored at `minHeight` so
 * a single-line input is always readable, and a degenerate window (keyboard +
 * chrome exceeding the window) can never return a negative height.
 */
export function resolveComposerMaxHeight({
  windowHeight,
  safeAreaInsetTop,
  safeAreaInsetBottom,
  keyboardHeight,
  sessionHeaderHeight,
  composerChromeHeight,
  minHeight,
}: {
  windowHeight: number;
  safeAreaInsetTop: number;
  safeAreaInsetBottom: number;
  keyboardHeight: number;
  sessionHeaderHeight: number;
  composerChromeHeight: number;
  minHeight: number;
}): number {
  const remaining =
    windowHeight -
    safeAreaInsetTop -
    safeAreaInsetBottom -
    keyboardHeight -
    sessionHeaderHeight -
    composerChromeHeight;
  return Math.max(minHeight, Math.floor(remaining));
}
