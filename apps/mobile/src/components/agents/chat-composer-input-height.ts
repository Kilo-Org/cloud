/**
 * Shared "scrollable at max height" threshold for the agents chat composer.
 * Mirror-Text (`useTextHeight`) owns growth measurement; this module keeps the
 * gate used by the row's `scrollEnabled` and the composer's swipe-down pan.
 */

export function shouldEnableComposerInputScroll(height: number, maxHeight: number): boolean {
  return height >= maxHeight;
}
