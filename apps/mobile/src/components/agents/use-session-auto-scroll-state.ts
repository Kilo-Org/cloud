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
 *
 * `followTail: false` opens the session without following the newest
 * message: a `?at=` deep-link resume lands on an older row, and the
 * mount-time scroll-to-end would otherwise override the resume scroll.
 * The button state stays at-bottom so the first real scroll event decides it.
 */
export function getInitialSessionListAutoScrollVisibility({
  followTail = true,
}: {
  followTail?: boolean;
} = {}) {
  return { shouldAutoScroll: followTail, isAtBottom: true };
}

/**
 * Decide whether a programmatic scroll-to-latest should be scheduled.
 *
 * Mirrors the guards inside `useSessionAutoScroll`'s `scheduleScrollToLatestMessage`:
 *  - `isAutoScrolling`     – a programmatic scroll is in flight, skip the retry.
 *  - `isUserScrolling`     – user is dragging or in momentum, never yank.
 *  - `shouldAutoScroll`    – the user has scrolled away from the bottom.
 *  - `newestKeyChanged`    – the newest item actually changed. Prepending an
 *    older page grows the list without moving the tail, so scheduling a
 *    scroll there would yank the viewport back to the newest message while
 *    the user is reading history. Callers that do not track item identity
 *    (layout/keyboard triggers) omit it and keep the previous behavior.
 */
export function shouldScheduleSessionAutoScroll({
  isAutoScrolling,
  isUserScrolling,
  shouldAutoScroll,
  newestKeyChanged = true,
}: {
  isAutoScrolling: boolean;
  isUserScrolling: boolean;
  shouldAutoScroll: boolean;
  newestKeyChanged?: boolean;
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
  if (!newestKeyChanged) {
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

/**
 * Decide whether a transcript viewport resize should trigger a follow scroll
 * to the latest message. The fixed status rows (the working indicator, the
 * session status indicator) live OUTSIDE the list, so they shrink the list's
 * viewport while its scroll offset stays put: the newest row is then left
 * below the fold and — because the list does not clip its overflow
 * (`removeClippedSubviews={false}`, see session-message-list.tsx) — is drawn
 * under the transparent status row. Re-pin on the resize.
 *
 * Like `shouldFollowSessionContentSize`, this does NOT gate on
 * `isAutoScrolling`: the resize lands during the streaming follow window, and
 * gating on it would drop exactly the correction this exists for. The
 * user-facing guards still apply, and an unchanged viewport height does not
 * take this path (the caller keeps the guarded scheduler for it), so a
 * redundant layout pass cannot stack scrolls.
 */
export function shouldFollowSessionViewportResize({
  isUserScrolling,
  shouldAutoScroll,
  didViewportHeightChange,
}: {
  isUserScrolling: boolean;
  shouldAutoScroll: boolean;
  didViewportHeightChange: boolean;
}): boolean {
  if (!shouldAutoScroll) {
    return false;
  }
  if (isUserScrolling) {
    return false;
  }
  if (!didViewportHeightChange) {
    return false;
  }
  return true;
}

/**
 * Who has claimed the transcript's position right now.
 *
 * One value for the three flags the list used to keep separately, so the
 * combinations they allowed — a live drag and a send's take-over at once, or
 * a send whose follow a stale fling event could turn off — cannot be
 * represented. `send` outranks a drag: the send owns the position until the
 * user drags again or a new `?at=` anchor arrives.
 */
export type SessionPositionClaim =
  | { readonly kind: 'free' }
  | { readonly kind: 'drag' }
  | { readonly kind: 'user' }
  | { readonly kind: 'send' };

const FREE: SessionPositionClaim = { kind: 'free' };
const DRAG: SessionPositionClaim = { kind: 'drag' };
const USER: SessionPositionClaim = { kind: 'user' };
const SEND: SessionPositionClaim = { kind: 'send' };

/** A drag replaces any earlier claim, including a send's. */
export function claimAfterDragBegin(claim: SessionPositionClaim): SessionPositionClaim {
  return claim.kind === 'drag' ? claim : DRAG;
}

/** A drag that ended leaves the user owning the position. */
export function claimAfterDragEnd(claim: SessionPositionClaim): SessionPositionClaim {
  return claim.kind === 'drag' ? USER : claim;
}

/**
 * A momentum end that follows a send cannot touch it: the fling is the drag's
 * trailing motion, and the send owns the position now.
 */
export function claimAfterMomentumEnd(claim: SessionPositionClaim): SessionPositionClaim {
  return claim.kind === 'drag' ? USER : claim;
}

/** A send takes the position over from anything. */
export function claimAfterSend(claim: SessionPositionClaim): SessionPositionClaim {
  return claim.kind === 'send' ? claim : SEND;
}

/** A session reset releases every claim. */
export function claimAfterReset(claim: SessionPositionClaim): SessionPositionClaim {
  return claim.kind === 'free' ? claim : FREE;
}

/**
 * A new `?at=` anchor owns the position again, which ends a send's take-over
 * but not the user's own drag or their settled position.
 */
export function claimAfterResumeAnchor(claim: SessionPositionClaim): SessionPositionClaim {
  return claim.kind === 'send' ? FREE : claim;
}

/** True while a drag or its momentum is live. */
export function claimIsDragging(claim: SessionPositionClaim): boolean {
  return claim.kind === 'drag';
}

/** True while a send owns the position. */
export function claimIsSend(claim: SessionPositionClaim): boolean {
  return claim.kind === 'send';
}

/** A claim the paging resume must not fight: a drag, a finished drag, or a send. */
export function claimBlocksResume(claim: SessionPositionClaim): boolean {
  return claim.kind !== 'free';
}

/** True while a scroll event may not turn the tail follow off. */
export function claimKeepsTail(claim: SessionPositionClaim): boolean {
  return claim.kind === 'send';
}
