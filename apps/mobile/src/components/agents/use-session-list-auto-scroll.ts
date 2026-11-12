import { type FlashListRef } from '@shopify/flash-list';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import {
  getInitialSessionListAutoScrollVisibility,
  isSessionListAtBottom,
  SESSION_LIST_BOTTOM_THRESHOLD_PX,
  shouldFollowSessionContentSize,
  shouldFollowSessionViewportResize,
  shouldRetrySessionAutoScroll,
  shouldScheduleSessionAutoScroll,
} from '@/components/agents/use-session-auto-scroll-state';
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
  /**
   * How much of a viewport shrink the caller already covers by shifting its
   * content, in dp. The chrome under the list grows, the layout pass takes that
   * height from the list, and the caller moves the content up by the same
   * amount in the same commit, so the rows the reader sees and the distance to
   * the newest row do not change. Treating that shrink as a viewport change
   * would re-pin the tail and move the content a second time, and treating it
   * as "away from the bottom" would show the scroll-to-bottom control beside a
   * transcript that is still on its newest row. Absent or 0 keeps every other
   * caller byte-identical.
   */
  coveredViewportGrowthDp?: number;
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
  coveredViewportGrowthDp = 0,
}: UseSessionListAutoScrollParams) {
  const listRef = useRef<FlashListRef<ItemT>>(null);
  // Read by the layout and scroll handlers, which must not be re-created on
  // every growth: the value they need is the current one, not a closure's.
  const coveredViewportGrowthRef = useRef(coveredViewportGrowthDp);
  coveredViewportGrowthRef.current = coveredViewportGrowthDp;
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
  // Whether the content is taller than the viewport, so the list can scroll at
  // all. Change-gated like `isAtBottom`: a transcript that cannot scroll has no
  // rows to bring back into view, and no caller may shift it.
  const [isScrollable, setIsScrollable] = useState(false);
  const isAutoScrollingRef = useRef(false);
  // Tracks whether the user is currently dragging or the list is still in a
  // momentum fling. While this is true we must not programmatically scroll —
  // otherwise a content-size update from a streaming response yanks the
  // viewport back to the bottom and the user's drag appears to "bounce back".
  const isUserScrollingRef = useRef(false);
  // "The position is taken" flag for the current attempt: set on the first
  // user drag and by a send's take-over, cleared when the session resets (or
  // when a later link's anchor releases a send's take-over). A scheduled
  // programmatic scroll (the `?at=` resume retries) must not fight a user who
  // has taken over the transcript — `isUserScrollingRef` only covers the drag
  // itself, while this covers everything after the user lets go.
  const userInteractedRef = useRef(false);
  // True when the take-over came from a send rather than from a drag. A send
  // ends the resume it interrupted and pins the tail, but the session's
  // position is not the send's to keep: the next link's anchor releases this
  // (see the reset effect) while a drag's claim outranks the link.
  const sendTakeoverRef = useRef(false);
  const lastContentHeightRef = useRef(0);
  // Newest item key seen by the previous render. The item-count effect
  // compares against it to tell a genuine append (newest key changed) from
  // an older page landing (count grew, newest key untouched).
  const lastNewestItemKeyRef = useRef<string | null>(null);
  // The list's own height, tracked so a viewport resize (the fixed status row
  // mounting outside the list) can re-pin the tail. See `handleListLayout`.
  const lastViewportHeightRef = useRef(0);
  const autoScrollResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoScrollRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userScrollingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAutoScrollResetTimeout = useCallback(() => {
    const timeout = autoScrollResetTimeoutRef.current;
    if (timeout) {
      clearTimeout(timeout);
      autoScrollResetTimeoutRef.current = null;
    }
  }, []);

  const clearAutoScrollRetryTimeout = useCallback(() => {
    const timeout = autoScrollRetryTimeoutRef.current;
    if (timeout) {
      clearTimeout(timeout);
      autoScrollRetryTimeoutRef.current = null;
    }
  }, []);

  const clearUserScrollingTimeout = useCallback(() => {
    const timeout = userScrollingTimeoutRef.current;
    if (timeout) {
      clearTimeout(timeout);
      userScrollingTimeoutRef.current = null;
    }
  }, []);

  // The newest row's bottom belongs to the viewport the reader sees. When the
  // caller covers part of the viewport by shifting the content, the list's own
  // end is that cover short of where the newest row must land, so the follow
  // targets the perceived bottom instead of the box's.
  const scrollToPerceivedBottom = useCallback((animated: boolean) => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const covered = coveredViewportGrowthRef.current;
    if (covered > 0 && lastViewportHeightRef.current > 0) {
      list.scrollToOffset({
        offset: Math.max(0, lastContentHeightRef.current - lastViewportHeightRef.current),
        animated,
      });
      return;
    }
    list.scrollToEnd({ animated });
  }, []);

  const scrollToLatestMessage = useCallback(() => {
    isAutoScrollingRef.current = true;
    clearAutoScrollResetTimeout();
    // FlashList in v2 supports `scrollToEnd` directly. The list is rendered
    // in chronological order, so the end is the newest message.
    scrollToPerceivedBottom(false);
    autoScrollResetTimeoutRef.current = setTimeout(() => {
      isAutoScrollingRef.current = false;
      autoScrollResetTimeoutRef.current = null;
    }, 150);
  }, [clearAutoScrollResetTimeout, scrollToPerceivedBottom]);

  // Animated scroll for the user-initiated "scroll to bottom" button.
  // Intentionally does NOT set `isAutoScrollingRef`: that flag suppresses
  // `onScroll` updates inside `handleScroll`, and we *want* the scroll
  // events produced by this animation to flow through
  // `updateAutoScrollFromEvent` so the at-bottom detection flips and the
  // button fades out on completion.
  const scrollToLatestAnimated = useCallback(() => {
    scrollToPerceivedBottom(scrollAnimated);
  }, [scrollAnimated, scrollToPerceivedBottom]);

  /**
   * A send takes the transcript position over. The user pressed Send wherever
   * the list sits — including an older row a `?at=` resume left with the tail
   * follow off — and the output that send produces must be on screen.
   *
   * The sticky takeover flag ends a resume that is still looking for its
   * anchor: its pending retries cancel themselves and its warm scroll drops,
   * so the take-over is not yanked back to the recorded row. Re-arming the
   * follow then pins the viewport to the newest row: the optimistic row, the
   * streamed reply, and every later content-size change.
   *
   * The take-over lasts for the session's current position, not for the whole
   * session: a later `?at=` link on the same mounted list releases it (the
   * reset effect), so a send cannot swallow that link's anchor.
   *
   * The scroll is issued directly instead of through
   * `scheduleScrollToLatestMessage`: the resume's suppression window can
   * still be armed when the user hits Send, and the guarded scheduler would
   * swallow this scroll for the rest of that window.
   */
  const followTailFromSend = useCallback(() => {
    userInteractedRef.current = true;
    sendTakeoverRef.current = true;
    shouldAutoScrollRef.current = true;
    setIsAtBottom(true);
    scrollToLatestMessage();
    clearAutoScrollRetryTimeout();
    autoScrollRetryTimeoutRef.current = setTimeout(() => {
      autoScrollRetryTimeoutRef.current = null;
      // Same safety net as `scheduleScrollToLatestMessage`: the sent rows are
      // still being measured when the first scroll lands, so the retry
      // catches the settled height.
      if (
        shouldRetrySessionAutoScroll({
          isUserScrolling: isUserScrollingRef.current,
          shouldAutoScroll: shouldAutoScrollRef.current,
        })
      ) {
        scrollToLatestMessage();
      }
    }, 80);
  }, [clearAutoScrollRetryTimeout, scrollToLatestMessage]);

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
      clearAutoScrollResetTimeout();
      autoScrollResetTimeoutRef.current = setTimeout(() => {
        isAutoScrollingRef.current = false;
        autoScrollResetTimeoutRef.current = null;
      }, ms);
    },
    [clearAutoScrollResetTimeout]
  );

  const scheduleScrollToLatestMessage = useCallback(
    (newestKeyChanged = true) => {
      if (
        !shouldScheduleSessionAutoScroll({
          isAutoScrolling: isAutoScrollingRef.current,
          isUserScrolling: isUserScrollingRef.current,
          shouldAutoScroll: shouldAutoScrollRef.current,
          newestKeyChanged,
        })
      ) {
        return;
      }
      scrollToLatestMessage();
      clearAutoScrollRetryTimeout();
      autoScrollRetryTimeoutRef.current = setTimeout(() => {
        autoScrollRetryTimeoutRef.current = null;
        // The 80ms safety-net retry must not gate on `isAutoScrolling`:
        // a programmatic scroll that's still within its 150ms window
        // would otherwise suppress the retry and make it dead during the
        // highest-frequency streaming window. It still honours the
        // user-facing and follow-bottom guards.
        if (
          shouldRetrySessionAutoScroll({
            isUserScrolling: isUserScrollingRef.current,
            shouldAutoScroll: shouldAutoScrollRef.current,
          })
        ) {
          scrollToLatestMessage();
        }
      }, 80);
    },
    [clearAutoScrollRetryTimeout, scrollToLatestMessage]
  );

  // A new session resets the follow policy and the sticky takeover flag. A
  // policy that flips on its own mid-session — a `?at=` resume whose anchor
  // never arrived, or whose older pages ran out — must not undo a takeover:
  // once the user has grabbed the transcript the follow stays off and the
  // resume retries stay cancelled, whatever the policy now says.
  //
  // A NEW anchor is not a policy flip: a later `?at=` link on this mounted list
  // owns the position again. It releases a send's take-over (the send took the
  // position for its output, it did not claim the session) and re-applies the
  // follow policy so the new resume is not yanked to the tail. A drag's
  // take-over is the user's own position and still outranks the link.
  const resetKeyRef = useRef(resetKey);
  const resumeKeyRef = useRef(resumeKey);
  useEffect(() => {
    const sessionChanged = resetKeyRef.current !== resetKey;
    resetKeyRef.current = resetKey;
    const resumeChanged = resumeKeyRef.current !== resumeKey;
    resumeKeyRef.current = resumeKey;
    if (resumeChanged && sendTakeoverRef.current) {
      userInteractedRef.current = false;
      sendTakeoverRef.current = false;
    }
    if (!sessionChanged && userInteractedRef.current) {
      return;
    }
    const initial = getInitialSessionListAutoScrollVisibility({ followTail: initialAutoScroll });
    shouldAutoScrollRef.current = initial.shouldAutoScroll;
    lastContentHeightRef.current = 0;
    lastNewestItemKeyRef.current = null;
    userInteractedRef.current = false;
    sendTakeoverRef.current = false;
    setIsAtBottom(prev => (prev === initial.isAtBottom ? prev : initial.isAtBottom));
  }, [resetKey, initialAutoScroll, resumeKey]);

  useEffect(() => {
    const newestKeyChanged = lastNewestItemKeyRef.current !== newestItemKey;
    lastNewestItemKeyRef.current = newestItemKey;
    if (itemCount > 0) {
      scheduleScrollToLatestMessage(newestKeyChanged);
    }
  }, [itemCount, newestItemKey, scheduleScrollToLatestMessage]);

  useEffect(
    () => () => {
      clearAutoScrollResetTimeout();
      clearAutoScrollRetryTimeout();
      clearUserScrollingTimeout();
    },
    [clearAutoScrollResetTimeout, clearAutoScrollRetryTimeout, clearUserScrollingTimeout]
  );

  const updateScrollableFromSizes = useCallback((contentHeight: number, viewportHeight: number) => {
    const nextIsScrollable = contentHeight > viewportHeight + 1;
    setIsScrollable(prev => (prev === nextIsScrollable ? prev : nextIsScrollable));
  }, []);

  const updateAutoScrollFromEvent = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      // The cover the caller applies in the same commit belongs to the viewport
      // the reader sees: without it, the shrink reads as a scroll away from the
      // newest row.
      const viewportHeight = layoutMeasurement.height + coveredViewportGrowthRef.current;
      updateScrollableFromSizes(contentSize.height, viewportHeight);
      const nextIsAtBottom = isSessionListAtBottom({
        contentHeight: contentSize.height,
        viewportHeight,
        offsetY: contentOffset.y,
        thresholdPx: SESSION_LIST_BOTTOM_THRESHOLD_PX,
      });
      shouldAutoScrollRef.current = nextIsAtBottom;
      // Change-gate the setState: returning the previous value when
      // unchanged is a React bail-out and avoids a re-render per scroll
      // frame while the user holds a steady position.
      setIsAtBottom(prev => (prev === nextIsAtBottom ? prev : nextIsAtBottom));
    },
    [updateScrollableFromSizes]
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
    isUserScrollingRef.current = true;
    userInteractedRef.current = true;
    // The user's own drag is the current claim on the position: it replaces a
    // send's take-over, which a later link is allowed to release (a drag's is
    // not).
    sendTakeoverRef.current = false;
    isAutoScrollingRef.current = false;
    clearAutoScrollResetTimeout();
    clearAutoScrollRetryTimeout();
    clearUserScrollingTimeout();
  }, [clearAutoScrollResetTimeout, clearAutoScrollRetryTimeout, clearUserScrollingTimeout]);

  const handleScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      updateAutoScrollFromEvent(event);
      // onMomentumScrollEnd is not guaranteed to fire for every drag (short or
      // slow drags release without momentum). Schedule a fallback clear so
      // isUserScrollingRef cannot get stuck at true. onMomentumScrollBegin
      // cancels this when real momentum is starting; onMomentumScrollEnd will
      // then clear the ref.
      clearUserScrollingTimeout();
      userScrollingTimeoutRef.current = setTimeout(() => {
        isUserScrollingRef.current = false;
        userScrollingTimeoutRef.current = null;
      }, 100);
    },
    [updateAutoScrollFromEvent, clearUserScrollingTimeout]
  );

  const handleMomentumScrollBegin = useCallback(() => {
    clearUserScrollingTimeout();
  }, [clearUserScrollingTimeout]);

  const handleMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      clearUserScrollingTimeout();
      isUserScrollingRef.current = false;
      updateAutoScrollFromEvent(event);
    },
    [updateAutoScrollFromEvent, clearUserScrollingTimeout]
  );

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      const didContentHeightChange = height !== lastContentHeightRef.current;
      lastContentHeightRef.current = height;
      updateScrollableFromSizes(height, lastViewportHeightRef.current);
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
          isUserScrolling: isUserScrollingRef.current,
          shouldAutoScroll: shouldAutoScrollRef.current,
          didContentHeightChange,
        })
      ) {
        scrollToLatestMessage();
      }
    },
    [scrollToLatestMessage, updateScrollableFromSizes]
  );

  const handleListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      // The height the reader perceives includes the shrink the caller covers
      // by shifting the content: a layout pass that takes exactly that shrink
      // away is not a viewport change.
      const covered = coveredViewportGrowthRef.current;
      const previousViewportHeight = lastViewportHeightRef.current;
      const viewportHeight = height + covered;
      const didViewportHeightChange = viewportHeight !== previousViewportHeight;
      const coveredShrink = covered > 0 && !didViewportHeightChange;
      lastViewportHeightRef.current = viewportHeight;
      updateScrollableFromSizes(lastContentHeightRef.current, viewportHeight);
      // The caller already put the newest row where this pass would; a follow
      // scroll here would move the content a second time, one frame late.
      if (coveredShrink) {
        return;
      }
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
          isUserScrolling: isUserScrollingRef.current,
          shouldAutoScroll: shouldAutoScrollRef.current,
          didViewportHeightChange,
        })
      ) {
        scrollToLatestMessage();
        return;
      }
      if (
        shouldScheduleSessionAutoScroll({
          isAutoScrolling: isAutoScrollingRef.current,
          isUserScrolling: isUserScrollingRef.current,
          shouldAutoScroll: shouldAutoScrollRef.current,
        })
      ) {
        scheduleScrollToLatestMessage();
      }
    },
    [scheduleScrollToLatestMessage, scrollToLatestMessage, updateScrollableFromSizes]
  );

  return {
    isAtBottom,
    isScrollable,
    listRef,
    scrollToLatestAnimated,
    suppressAutoFollow,
    /**
     * The host's send path calls this so the transcript follows the output the
     * send produces, wherever the viewport sits. See `followTailFromSend`.
     */
    followTailFromSend,
    /**
     * Live "user is dragging or momentum is in flight" flag. A scheduled
     * programmatic scroll (the `?at=` resume retries) reads it so a retry
     * never yanks the list out of the user's drag.
     */
    isUserScrollingRef,
    /**
     * Sticky "the user has grabbed this transcript" flag for the current
     * session. A scheduled resume scroll cancels itself once this is true:
     * after the first drag the position belongs to the user, not the link.
     */
    userInteractedRef,
    /**
     * True while a send's take-over is the current claim on the position (the
     * send's row and its reply, not the user's own scroll). The resume reads it
     * to end its paging: a position a send took over must not keep pulling in
     * older pages. Cleared when the user drags or a later link's anchor
     * arrives.
     */
    sendTakeoverRef,
    handleContentSizeChange,
    handleListLayout,
    handleScroll,
    handleScrollBeginDrag,
    handleScrollEndDrag,
    handleMomentumScrollBegin,
    handleMomentumScrollEnd,
  };
}
