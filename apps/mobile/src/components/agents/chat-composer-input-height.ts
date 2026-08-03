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
