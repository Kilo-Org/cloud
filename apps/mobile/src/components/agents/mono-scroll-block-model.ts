/**
 * Caps long mono payloads for display. Returns a sliced copy and whether the
 * cap applied — never mutates the caller's string.
 */
export function prepareMonoScrollContent(
  content: string,
  maxLength?: number
): { displayText: string; isTruncated: boolean } {
  if (maxLength === undefined || content.length <= maxLength) {
    return { displayText: content, isTruncated: false };
  }
  return { displayText: content.slice(0, maxLength), isTruncated: true };
}

/** Measured ScrollView height keyed to the text it was measured for. */
export type MonoScrollHeightPin = { text: string; height: number };

/**
 * Apply a pinned height only while it still matches the displayed text.
 * When text changes the pin is ignored so the next layout remeasures
 * intrinsic height (avoids clipping grown content into a stale pin).
 */
export function resolveMonoScrollPinnedHeight(
  pin: MonoScrollHeightPin | undefined,
  displayText: string
): number | undefined {
  if (pin === undefined || pin.text !== displayText) {
    return undefined;
  }
  return pin.height;
}

/** Record a fresh measurement, keeping the previous pin when nothing changed. */
export function nextMonoScrollHeightPin(
  prev: MonoScrollHeightPin | undefined,
  displayText: string,
  measuredHeight: number
): MonoScrollHeightPin {
  if (prev?.text === displayText && Math.abs(prev.height - measuredHeight) < 0.5) {
    return prev;
  }
  return { text: displayText, height: measuredHeight };
}

/** Props applied to the horizontal ScrollView so tests can assert the contract. */
export const MONO_SCROLL_VIEW_PROPS = {
  horizontal: true as const,
  showsHorizontalScrollIndicator: true as const,
  // iOS: once the pan direction is chosen, keep it so a horizontal drag does
  // not also scroll the conversation FlashList, and a mostly-vertical drag
  // stays with the list.
  directionalLockEnabled: true as const,
  // Android: allow this horizontal scroller inside the vertical list.
  nestedScrollEnabled: true as const,
  // Do not let the scroller steal the vertical list's bounce/cancel path on
  // primarily vertical drags that begin on the block.
  canCancelContentTouches: true as const,
};
