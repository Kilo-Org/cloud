// Default 100px matches the existing auto-scroll behaviour: as long as the
// viewport bottom is within ~100px of the content bottom, the user is
// considered "at the bottom" and the next content-size growth auto-scrolls.
export const SESSION_LIST_BOTTOM_THRESHOLD_PX = 100;

export function isSessionListAtBottom({
  contentHeight,
  viewportHeight,
  offsetY,
  thresholdPx = SESSION_LIST_BOTTOM_THRESHOLD_PX,
}: {
  contentHeight: number;
  viewportHeight: number;
  offsetY: number;
  thresholdPx?: number;
}): boolean {
  const distanceFromBottom = contentHeight - offsetY - viewportHeight;
  return distanceFromBottom < thresholdPx;
}

/**
 * Decide whether a programmatic scroll-to-latest should be scheduled.
 *
 * Mirrors the four guards inside `useSessionAutoScroll`'s `scheduleScrollToLatestMessage`:
 *  - `isAutoScrolling`     – a programmatic scroll is in flight, skip the retry.
 *  - `isUserScrolling`     – user is dragging or in momentum, never yank.
 *  - `shouldAutoScroll`    – the user has scrolled away from the bottom.
 */
export function shouldScheduleSessionAutoScroll({
  isAutoScrolling,
  isUserScrolling,
  shouldAutoScroll,
}: {
  isAutoScrolling: boolean;
  isUserScrolling: boolean;
  shouldAutoScroll: boolean;
}): boolean {
  if (!shouldAutoScroll) {
    return false;
  }
  if (isUserScrolling) {
    return false;
  }
  if (isAutoScrolling) {
    return false;
  }
  return true;
}
