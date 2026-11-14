import { type FlashListRef } from '@shopify/flash-list';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import {
  claimAfterDragBegin,
  claimAfterDragEnd,
  claimAfterMomentumEnd,
  claimAfterReset,
  claimAfterResumeAnchor,
  claimAfterSend,
  claimBlocksResume,
  claimIsDragging,
  claimKeepsTail,
  getInitialSessionListAutoScrollVisibility,
  isSessionListAtBottom,
  SESSION_LIST_BOTTOM_THRESHOLD_PX,
  type SessionPositionClaim,
  shouldFollowSessionContentSize,
  shouldFollowSessionViewportResize,
  shouldRetrySessionAutoScroll,
  shouldScheduleSessionAutoScroll,
} from '@/components/agents/use-session-auto-scroll-state';
import {
  DRAG_SETTLE_MS,
  MOMENTUM_BOUND_MS,
  useSessionListScrollTimeouts,
} from '@/components/agents/use-session-list-scroll-timeouts';
import { useSessionTailRepin } from '@/components/agents/use-session-tail-repin';
import { useMotionPolicy } from '@/lib/a11y/motion';

type UseSessionListAutoScrollParams = {
  itemCount: number;
  /**
   * Key of `items.at(-1)` (the newest item) or `null` for an empty list.
   * The item-count effect only schedules a scroll when this key changes, so
   * prepending an older page (count grows, newest unchanged) can never yank
   * the viewport back to the newest message.
   */
  newestItemKey: string | null;
  resetKey: string;
  /**
   * Whether the session opens following the newest message. Default true keeps
   * every existing caller byte-identical. A `?at=` resume passes false: the
   * list opens on an older row and the mount-time scroll-to-end (and its 80ms
   * safety-net retry) would otherwise scroll the viewport back to the bottom,
   * discarding the resume position.
   */
  initialAutoScroll?: boolean;
  /**
   * The `?at=` anchor this list is resuming, or null when it is not resuming.
   * A send's take-over ends the resume it interrupted, but — unlike a user drag
   * — it is not a claim on the session's position: a later link's anchor starts
   * a fresh resume on the same mounted list, and only then is the send's
   * take-over released and the follow policy re-applied.
   */
  resumeKey?: string | null;
};

/**
 * FlashList-compatible companion to `useSessionAutoScroll`. Mirrors the
 * "follow the latest message" behavior: keep auto-following while the user
 * is at the bottom, stop once they scroll away, never yank during drag or
 * momentum. Pure decisions live in `use-session-auto-scroll-state` for
 * unit testing without React.
 */
export function useSessionListAutoScroll<ItemT>({
  itemCount,
  newestItemKey,
  resetKey,
  initialAutoScroll = true,
  resumeKey = null,
}: UseSessionListAutoScrollParams) {
  const listRef = useRef<FlashListRef<ItemT>>(null);
  const { scrollAnimated } = useMotionPolicy();
  const shouldAutoScrollRef = useRef(true);
  // React state mirror of `shouldAutoScrollRef`'s at-bottom side, so the
  // scroll-to-bottom button can be conditionally rendered. Updated through
  // `setIsAtBottom` which is change-gated (functional update returning the
  // previous value when unchanged) to avoid re-render churn on every
  // scroll frame.
  const [isAtBottom, setIsAtBottom] = useState<boolean>(
    getInitialSessionListAutoScrollVisibility().isAtBottom
  );
  const isAutoScrollingRef = useRef(false);
  // Who owns the transcript's position right now — the drag, the user's
  // settled position, or a send's take-over. One value for the three flags
  // this replaced: they could disagree (a live fling beside a send), and a
  // stale fling event could then turn the send's follow off.
  const claimRef = useRef<SessionPositionClaim>({ kind: 'free' });
  const lastContentHeightRef = useRef(0);
  // Newest item key seen by the previous render. The item-count effect
  // compares against it to tell a genuine append (newest key changed) from
  // an older page landing (count grew, newest key untouched).
  const lastNewestItemKeyRef = useRef<string | null>(null);
  // The list's own height, tracked so a viewport resize (the fixed status row
  // mounting outside the list) can re-pin the tail. See `handleListLayout`.
  const lastViewportHeightRef = useRef(0);
  const timeouts = useSessionListScrollTimeouts();

  const scrollToLatestMessage = useCallback(() => {
    isAutoScrollingRef.current = true;
    timeouts.clearReset();
    // FlashList in v2 supports `scrollToEnd` directly. The list is rendered
    // in chronological order, so the end is the newest message.
    listRef.current?.scrollToEnd({ animated: false });
    timeouts.resetRef.current = setTimeout(() => {
      isAutoScrollingRef.current = false;
      timeouts.resetRef.current = null;
    }, 150);
  }, [timeouts]);

  const tailRepin = useSessionTailRepin(
    () =>
      shouldRetrySessionAutoScroll({
        isUserScrolling: claimIsDragging(claimRef.current),
        shouldAutoScroll: shouldAutoScrollRef.current,
      }),
    scrollToLatestMessage
  );

  const scrollToLatestAnimated = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: scrollAnimated });
  }, [scrollAnimated]);

  /**
   * A send takes the transcript position over. The user pressed Send wherever
   * the list sits — including an older row a `?at=` resume left with the tail
   * follow off — and the output that send produces must be on screen.
   *
   * A send's claim ends a resume that is still looking for its anchor: its
   * pending retries cancel themselves and its warm scroll drops, so the
   * take-over is not yanked back to the recorded row. Re-arming the follow
   * then pins the viewport to the newest row: the optimistic row, the streamed
   * reply, and every later content-size change. The claim outranks the drag it
   * interrupted, so the fling's trailing events cannot turn the follow off.
   *
   * The claim lasts for the session's current position, not for the whole
   * session: a later `?at=` link on the same mounted list releases it (the
   * reset effect), so a send cannot swallow that link's anchor.
   *
   * The scroll is issued directly instead of through
   * `scheduleScrollToLatestMessage`: the resume's suppression window can
   * still be armed when the user hits Send, and the guarded scheduler would
   * swallow this scroll for the rest of that window.
   */
  const followTailFromSend = useCallback(() => {
    claimRef.current = claimAfterSend(claimRef.current);
    // The motion keeps its own bound: a send owns the position, not the fling
    // it interrupted, and clearing the bound here would leave the list "moving"
    // for as long as the platform never reports the fling's end.
    shouldAutoScrollRef.current = true;
    setIsAtBottom(true);
    scrollToLatestMessage();
    timeouts.clearRetry();
    timeouts.retryRef.current = setTimeout(() => {
      timeouts.retryRef.current = null;
      // Same safety net as `scheduleScrollToLatestMessage`: the sent rows are
      // still being measured when the first scroll lands, so the retry
      // catches the settled height.
      if (
        shouldRetrySessionAutoScroll({
          isUserScrolling: claimIsDragging(claimRef.current),
          shouldAutoScroll: shouldAutoScrollRef.current,
        })
      ) {
        scrollToLatestMessage();
      }
    }, 80);
  }, [timeouts, scrollToLatestMessage]);

  /**
   * Suppresses the tail follow for a bounded window. A scheduled programmatic
   * resume scroll produces scroll events of its own, and FlashList's own
   * bottom-start initial scroll races them; every one of those scroll events
   * reads "at the bottom" and would arm the tail follow
   * (`shouldAutoScrollRef`), so the next content-size change yanks the
   * viewport back to the newest message and discards the resume. While the
   * suppression is on, `handleScroll` skips the at-bottom update (the same
   * mechanism the 150ms `scrollToEnd` window uses), so the follow stays off
   * until the resume has landed. A resume open arms this at mount, before
   * FlashList's bottom-start events arrive, and re-arms it on every retry.
   */
  const suppressAutoFollow = useCallback(
    (ms: number) => {
      isAutoScrollingRef.current = true;
      timeouts.clearReset();
      timeouts.resetRef.current = setTimeout(() => {
        isAutoScrollingRef.current = false;
        timeouts.resetRef.current = null;
      }, ms);
    },
    [timeouts]
  );

  const scheduleScrollToLatestMessage = useCallback(
    (newestKeyChanged = true) => {
      if (
        !shouldScheduleSessionAutoScroll({
          isAutoScrolling: isAutoScrollingRef.current,
          isUserScrolling: claimIsDragging(claimRef.current),
          shouldAutoScroll: shouldAutoScrollRef.current,
          newestKeyChanged,
        })
      ) {
        return;
      }
      scrollToLatestMessage();
      timeouts.clearRetry();
      timeouts.retryRef.current = setTimeout(() => {
        timeouts.retryRef.current = null;
        // The 80ms safety-net retry must not gate on `isAutoScrolling`:
        // a programmatic scroll that's still within its 150ms window
        // would otherwise suppress the retry and make it dead during the
        // highest-frequency streaming window. It still honours the
        // user-facing and follow-bottom guards.
        if (
          shouldRetrySessionAutoScroll({
            isUserScrolling: claimIsDragging(claimRef.current),
            shouldAutoScroll: shouldAutoScrollRef.current,
          })
        ) {
          scrollToLatestMessage();
        }
      }, 80);
    },
    [timeouts, scrollToLatestMessage]
  );

  // A new session resets the follow policy and the position claim. A policy
  // that flips on its own mid-session — a `?at=` resume whose anchor never
  // arrived, or whose older pages ran out — must not undo a claim: once the
  // user has grabbed the transcript the follow stays off and the resume
  // retries stay cancelled, whatever the policy now says.
  //
  // A NEW anchor is not a policy flip: a later `?at=` link on this mounted list
  // owns the position again. It releases a send's claim (the send took the
  // position for its output, it did not claim the session) and re-applies the
  // follow policy so the new resume is not yanked to the tail. A drag's claim
  // is the user's own position and still outranks the link.
  const resetKeyRef = useRef(resetKey);
  const resumeKeyRef = useRef(resumeKey);
  useEffect(() => {
    const sessionChanged = resetKeyRef.current !== resetKey;
    resetKeyRef.current = resetKey;
    if (sessionChanged) {
      // A session reset is not a new anchor: whatever was moving belonged to the
      // conversation being left, and nothing will report its end.
      timeouts.endMotion();
    }
    const resumeChanged = resumeKeyRef.current !== resumeKey;
    resumeKeyRef.current = resumeKey;
    if (resumeChanged) {
      claimRef.current = claimAfterResumeAnchor(claimRef.current);
    }
    if (!sessionChanged && claimBlocksResume(claimRef.current)) {
      return;
    }
    const initial = getInitialSessionListAutoScrollVisibility({ followTail: initialAutoScroll });
    shouldAutoScrollRef.current = initial.shouldAutoScroll;
    lastContentHeightRef.current = 0;
    lastNewestItemKeyRef.current = null;
    claimRef.current = claimAfterReset(claimRef.current);
    setIsAtBottom(prev => (prev === initial.isAtBottom ? prev : initial.isAtBottom));
  }, [resetKey, initialAutoScroll, resumeKey, timeouts]);

  useEffect(() => {
    const newestKeyChanged = lastNewestItemKeyRef.current !== newestItemKey;
    lastNewestItemKeyRef.current = newestItemKey;
    if (itemCount > 0) {
      scheduleScrollToLatestMessage(newestKeyChanged);
    }
  }, [itemCount, newestItemKey, scheduleScrollToLatestMessage]);

  const updateAutoScrollFromEvent = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const nextIsAtBottom = isSessionListAtBottom({
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
        offsetY: contentOffset.y,
        thresholdPx: SESSION_LIST_BOTTOM_THRESHOLD_PX,
      });
      shouldAutoScrollRef.current = claimKeepsTail(claimRef.current) || nextIsAtBottom;
      // Change-gate the setState: returning the previous value when
      // unchanged is a React bail-out and avoids a re-render per scroll
      // frame while the user holds a steady position.
      setIsAtBottom(prev => (prev === nextIsAtBottom ? prev : nextIsAtBottom));
    },
    []
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (isAutoScrollingRef.current) {
        return;
      }
      updateAutoScrollFromEvent(event);
    },
    [updateAutoScrollFromEvent]
  );

  const handleScrollBeginDrag = useCallback(() => {
    // The user's own drag is the current claim on the position: it replaces a
    // send's claim, which a later link is allowed to release (a drag's is not).
    claimRef.current = claimAfterDragBegin(claimRef.current);
    isAutoScrollingRef.current = false;
    timeouts.beginMotion();
    timeouts.clearReset();
    timeouts.clearRetry();
  }, [timeouts]);

  const handleScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      updateAutoScrollFromEvent(event);
      // onMomentumScrollEnd is not guaranteed to fire for every drag (short or
      // slow drags release without momentum). The settle ends both the motion
      // and the claim; a real fling replaces it with its own bound.
      timeouts.settleMotion(DRAG_SETTLE_MS, () => {
        claimRef.current = claimAfterDragEnd(claimRef.current);
      });
    },
    [timeouts, updateAutoScrollFromEvent]
  );

  const handleMomentumScrollBegin = useCallback(() => {
    // The fling is real, and it may never report its end: one bound, not none.
    timeouts.settleMotion(MOMENTUM_BOUND_MS);
  }, [timeouts]);

  const handleMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      timeouts.endMotion();
      // A late momentum end follows a drag; a send's claim outranks it.
      claimRef.current = claimAfterMomentumEnd(claimRef.current);
      updateAutoScrollFromEvent(event);
    },
    [timeouts, updateAutoScrollFromEvent]
  );

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      const didContentHeightChange = height !== lastContentHeightRef.current;
      lastContentHeightRef.current = height;
      // Content-size follow must not gate on `isAutoScrolling`: rapid
      // streaming content-size changes that arrive during the 150ms
      // programmatic-scroll window must still keep the viewport pinned
      // to the bottom. Gating on `!isAutoScrolling` here would silently
      // drop every streaming update that lands inside the debounce
      // window. Bypass `scheduleScrollToLatestMessage` (which keeps
      // the `!isAutoScrolling` guard for the initial itemCount trigger)
      // and trigger the programmatic scroll directly.
      if (
        shouldFollowSessionContentSize({
          isUserScrolling: claimIsDragging(claimRef.current),
          shouldAutoScroll: shouldAutoScrollRef.current,
          didContentHeightChange,
        })
      ) {
        tailRepin.push(null);
      }
    },
    [tailRepin]
  );

  const handleListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      const didViewportHeightChange = height !== lastViewportHeightRef.current;
      lastViewportHeightRef.current = height;
      // A viewport resize is the same hazard as a content-size change: the
      // fixed status rows mount OUTSIDE the list, so the list gets shorter
      // while its offset stays put and the newest row is left below the fold,
      // drawn over the transparent status row. Re-pin the tail directly —
      // bypassing `scheduleScrollToLatestMessage`'s `!isAutoScrolling` guard
      // for the same reason `handleContentSizeChange` does: the resize lands
      // inside the streaming follow window, and the guarded scheduler would
      // swallow exactly the correction this exists for.
      if (
        shouldFollowSessionViewportResize({
          isUserScrolling: claimIsDragging(claimRef.current),
          shouldAutoScroll: shouldAutoScrollRef.current,
          didViewportHeightChange,
        })
      ) {
        tailRepin.push(null);
        return;
      }
      if (
        shouldScheduleSessionAutoScroll({
          isAutoScrolling: isAutoScrollingRef.current,
          isUserScrolling: claimIsDragging(claimRef.current),
          shouldAutoScroll: shouldAutoScrollRef.current,
        })
      ) {
        scheduleScrollToLatestMessage();
      }
    },
    [scheduleScrollToLatestMessage, tailRepin]
  );

  return {
    isAtBottom,
    listRef,
    scrollToLatestAnimated,
    suppressAutoFollow,
    /**
     * The host's send path calls this so the transcript follows the output the
     * send produces, wherever the viewport sits. See `followTailFromSend`.
     */
    followTailFromSend,
    /**
     * The live claim on the transcript's position: a drag, the user's settled
     * position, a send's take-over, or free. The `?at=` resume and its retries
     * read it so they never fight a drag, a settled user, or a send.
     */
    claimRef,
    /**
     * True while the list is moving under the user. Ownership and motion are
     * different facts: a send takes the position over without ending the fling
     * it interrupted, and a resume must not scroll mid-fling. Its one writer is
     * the timeouts hook, which ends it on every path that ends motion.
     */
    motionRef: timeouts.motionRef,
    handleContentSizeChange,
    handleListLayout,
    handleScroll,
    handleScrollBeginDrag,
    handleScrollEndDrag,
    handleMomentumScrollBegin,
    handleMomentumScrollEnd,
  };
}
