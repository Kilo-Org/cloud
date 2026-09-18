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
export function getInitialSessionListAutoScrollVisibility() {
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
 * How the transcript changed since the previous render. FlashList only
 * reports a raw content-size growth, which cannot tell a streaming
 * insertion at the bottom apart from a page of older messages landing
 * above the viewport. The key delta can:
 *  - `none`    – the item count is unchanged.
 *  - `prepend` – older messages were inserted before the existing first
 *                key while the newest key stayed put.
 *  - `append`  – a new message landed after the previous last key while
 *                the oldest key stayed put (streaming).
 *  - `replace` – anything else (session swap, first render, item
 *                identity churn); treated as a fresh transcript.
 */
export type SessionTranscriptGrowth = 'none' | 'replace' | 'append' | 'prepend';

export function classifySessionTranscriptGrowth({
  previousCount,
  nextCount,
  previousFirstKey,
  nextFirstKey,
  previousLastKey,
  nextLastKey,
}: {
  previousCount: number;
  nextCount: number;
  previousFirstKey: string | null;
  nextFirstKey: string | null;
  previousLastKey: string | null;
  nextLastKey: string | null;
}): SessionTranscriptGrowth {
  if (previousCount === nextCount) {
    return 'none';
  }
  const firstChanged = previousFirstKey !== nextFirstKey;
  const lastChanged = previousLastKey !== nextLastKey;
  if (firstChanged && !lastChanged) {
    return 'prepend';
  }
  if (lastChanged && !firstChanged) {
    return 'append';
  }
  return 'replace';
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
 *
 * `isPrepend` blocks the follow outright: a page of older messages grows
 * the content but must hold the user's reading position, even when the
 * stale `shouldAutoScroll` ref is still true inside the 150ms window.
 * Optional (defaults to false) because the part-detail ScrollView has no
 * paginated prepends.
 */
export function shouldFollowSessionContentSize({
  isUserScrolling,
  shouldAutoScroll,
  didContentHeightChange,
  isPrepend = false,
}: {
  isUserScrolling: boolean;
  shouldAutoScroll: boolean;
  didContentHeightChange: boolean;
  isPrepend?: boolean;
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
  if (isPrepend) {
    return false;
  }
  return true;
}
