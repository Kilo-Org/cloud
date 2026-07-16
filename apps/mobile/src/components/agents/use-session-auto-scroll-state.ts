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
 * Initial (and per-session-reset) visibility state for the
 * scroll-to-bottom affordance. The user is considered at the bottom at
 * the start of every session — a fresh transcript is rendered anchored
 * to the latest message, so the floating "scroll to bottom" button
 * must never be visible until the user has actually scrolled away.
 */
export function getInitialSessionListAutoScrollVisibility(): {
  shouldAutoScroll: boolean;
  isAtBottom: boolean;
} {
  return { shouldAutoScroll: true, isAtBottom: true };
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

/**
 * Decide whether the 80ms safety-net retry should re-scroll to the latest
 * message. Unlike `shouldScheduleSessionAutoScroll`, this does NOT gate on
 * `isAutoScrolling`: the whole point of the retry is to recover when the
 * first scroll didn't reach the bottom, and a programmatic scroll that's
 * still in flight (within the 150ms `isAutoScrolling` window) must not
 * suppress the retry. It must still honour the user-facing guards:
 *  - `isUserScrolling`  – the user is dragging or in momentum, never yank.
 *  - `shouldAutoScroll` – the user has scrolled away from the bottom.
 */
export function shouldRetrySessionAutoScroll({
  isUserScrolling,
  shouldAutoScroll,
}: {
  isUserScrolling: boolean;
  shouldAutoScroll: boolean;
}): boolean {
  if (!shouldAutoScroll) {
    return false;
  }
  if (isUserScrolling) {
    return false;
  }
  return true;
}

/**
 * Decide whether a streaming content-size change should trigger a follow
 * scroll to the latest message. Like `shouldRetrySessionAutoScroll`, this
 * does NOT gate on `isAutoScrolling`: rapid streaming content-size changes
 * that arrive during the 150ms programmatic-scroll window must still keep
 * the viewport pinned to the bottom. It still honours the user-facing
 * guards and additionally requires the content height to have actually
 * changed since the last call (otherwise every redundant measurement would
 * re-scroll even when no new content was added).
 */
export function shouldFollowSessionContentSize({
  isUserScrolling,
  shouldAutoScroll,
  didContentHeightChange,
}: {
  isUserScrolling: boolean;
  shouldAutoScroll: boolean;
  didContentHeightChange: boolean;
}): boolean {
  if (!shouldAutoScroll) {
    return false;
  }
  if (isUserScrolling) {
    return false;
  }
  if (!didContentHeightChange) {
    return false;
  }
  return true;
}
