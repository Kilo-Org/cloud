import { type FlashListRef } from '@shopify/flash-list';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import {
  classifySessionTranscriptGrowth,
  getInitialSessionListAutoScrollVisibility,
  isSessionListAtBottom,
  SESSION_LIST_BOTTOM_THRESHOLD_PX,
  type SessionTranscriptGrowth,
  shouldFollowSessionContentSize,
  shouldRetrySessionAutoScroll,
  shouldScheduleSessionAutoScroll,
} from '@/components/agents/use-session-auto-scroll-state';
import { useMotionPolicy } from '@/lib/a11y/motion';

// A page of older messages grows the content exactly like a streaming
// append, so the follow must be held for the page's own measurement burst.
// The hold outlasts the 150ms programmatic-scroll window in which
// `handleScroll` suppresses `onScroll`, so the page's growth cannot fire
// through a stale follow guard. It is deliberately bounded: it is released
// once those measurements settle, so a later in-place growth of the last row
// (same item count and keys, which the classifier reports as `none`) is
// followed again instead of staying blocked for the rest of the session.
const PREPEND_GROWTH_HOLD_MS = 200;

type UseSessionListAutoScrollParams = {
  itemCount: number;
  /**
   * Identity of the oldest and newest items. They let the hook tell a
   * prepended older page apart from a streaming append, so a content-size
   * growth can be followed or held accordingly.
   */
  firstItemKey?: string | null;
  lastItemKey?: string | null;
  resetKey: string;
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
  firstItemKey,
  lastItemKey,
  resetKey,
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
  // Tracks whether the user is currently dragging or the list is still in a
  // momentum fling. While this is true we must not programmatically scroll —
  // otherwise a content-size update from a streaming response yanks the
  // viewport back to the bottom and the user's drag appears to "bounce back".
  const isUserScrollingRef = useRef(false);
  const lastContentHeightRef = useRef(0);
  const autoScrollResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoScrollRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userScrollingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Previous transcript identity, compared against the current props to
  // classify the growth. `growthRef` is read by the native
  // `onContentSizeChange` callback, which cannot see the render that
  // produced the new content.
  const previousItemCountRef = useRef(0);
  const previousFirstItemKeyRef = useRef<string | null>(null);
  const previousLastItemKeyRef = useRef<string | null>(null);
  const growthRef = useRef<SessionTranscriptGrowth>('none');
  // Releases the prepend hold once the older page's measurements settle.
  const prependGrowthReleaseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const clearPrependGrowthReleaseTimeout = useCallback(() => {
    const timeout = prependGrowthReleaseTimeoutRef.current;
    if (timeout) {
      clearTimeout(timeout);
      prependGrowthReleaseTimeoutRef.current = null;
    }
  }, []);

  // Hold the follow only for the prepend's own measurement burst. Once the
  // burst settles the classification falls back to `none`, so the next
  // content-size growth (an in-place streaming update of the last row) is
  // followed again.
  const schedulePrependGrowthRelease = useCallback(() => {
    clearPrependGrowthReleaseTimeout();
    prependGrowthReleaseTimeoutRef.current = setTimeout(() => {
      prependGrowthReleaseTimeoutRef.current = null;
      if (growthRef.current === 'prepend') {
        growthRef.current = 'none';
      }
    }, PREPEND_GROWTH_HOLD_MS);
  }, [clearPrependGrowthReleaseTimeout]);

  const scrollToLatestMessage = useCallback(() => {
    isAutoScrollingRef.current = true;
    clearAutoScrollResetTimeout();
    // FlashList in v2 supports `scrollToEnd` directly. The list is rendered
    // in chronological order, so the end is the newest message.
    listRef.current?.scrollToEnd({ animated: false });
    autoScrollResetTimeoutRef.current = setTimeout(() => {
      isAutoScrollingRef.current = false;
      autoScrollResetTimeoutRef.current = null;
    }, 150);
  }, [clearAutoScrollResetTimeout]);

  // Animated scroll for the user-initiated "scroll to bottom" button.
  // Intentionally does NOT set `isAutoScrollingRef`: that flag suppresses
  // `onScroll` updates inside `handleScroll`, and we *want* the scroll
  // events produced by this animation to flow through
  // `updateAutoScrollFromEvent` so the at-bottom detection flips and the
  // button fades out on completion.
  const scrollToLatestAnimated = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: scrollAnimated });
  }, [scrollAnimated]);

  const scheduleScrollToLatestMessage = useCallback(() => {
    if (
      !shouldScheduleSessionAutoScroll({
        isAutoScrolling: isAutoScrollingRef.current,
        isUserScrolling: isUserScrollingRef.current,
        shouldAutoScroll: shouldAutoScrollRef.current,
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
  }, [clearAutoScrollRetryTimeout, scrollToLatestMessage]);

  useEffect(() => {
    const initial = getInitialSessionListAutoScrollVisibility();
    shouldAutoScrollRef.current = initial.shouldAutoScroll;
    lastContentHeightRef.current = 0;
    previousItemCountRef.current = 0;
    previousFirstItemKeyRef.current = null;
    previousLastItemKeyRef.current = null;
    growthRef.current = 'none';
    clearPrependGrowthReleaseTimeout();
    setIsAtBottom(prev => (prev === initial.isAtBottom ? prev : initial.isAtBottom));
  }, [resetKey, clearPrependGrowthReleaseTimeout]);

  // Classify this render's transcript growth before the native
  // content-size callback can fire: it needs to know whether the growth is
  // a prepended older page (hold position) or an append (follow).
  useEffect(() => {
    const nextFirstKey = firstItemKey ?? null;
    const nextLastKey = lastItemKey ?? null;
    const growth = classifySessionTranscriptGrowth({
      previousCount: previousItemCountRef.current,
      nextCount: itemCount,
      previousFirstKey: previousFirstItemKeyRef.current,
      nextFirstKey,
      previousLastKey: previousLastItemKeyRef.current,
      nextLastKey,
    });
    growthRef.current = growth;
    previousItemCountRef.current = itemCount;
    previousFirstItemKeyRef.current = nextFirstKey;
    previousLastItemKeyRef.current = nextLastKey;
    // An older page is a content growth too, but it landed above the
    // viewport: following it would yank the user to the bottom mid-read.
    // Hold the follow only for the page's own measurement burst so a later
    // in-place growth of the last row (same item count and keys) is followed
    // again instead of staying blocked.
    if (growth === 'prepend') {
      schedulePrependGrowthRelease();
      return;
    }
    clearPrependGrowthReleaseTimeout();
    if (itemCount > 0 && shouldAutoScrollRef.current && !isUserScrollingRef.current) {
      scheduleScrollToLatestMessage();
    }
  }, [
    itemCount,
    firstItemKey,
    lastItemKey,
    scheduleScrollToLatestMessage,
    schedulePrependGrowthRelease,
    clearPrependGrowthReleaseTimeout,
  ]);

  useEffect(
    () => () => {
      clearAutoScrollResetTimeout();
      clearAutoScrollRetryTimeout();
      clearUserScrollingTimeout();
      clearPrependGrowthReleaseTimeout();
    },
    [
      clearAutoScrollResetTimeout,
      clearAutoScrollRetryTimeout,
      clearUserScrollingTimeout,
      clearPrependGrowthReleaseTimeout,
    ]
  );

  const updateAutoScrollFromEvent = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const nextIsAtBottom = isSessionListAtBottom({
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
        offsetY: contentOffset.y,
        thresholdPx: SESSION_LIST_BOTTOM_THRESHOLD_PX,
      });
      shouldAutoScrollRef.current = nextIsAtBottom;
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
    isUserScrollingRef.current = true;
    isAutoScrollingRef.current = false;
    // A user gesture re-derives the at-bottom position from real scroll
    // events, so any hold left over from a prepend is no longer needed.
    clearPrependGrowthReleaseTimeout();
    growthRef.current = 'none';
    clearAutoScrollResetTimeout();
    clearAutoScrollRetryTimeout();
    clearUserScrollingTimeout();
  }, [
    clearAutoScrollResetTimeout,
    clearAutoScrollRetryTimeout,
    clearUserScrollingTimeout,
    clearPrependGrowthReleaseTimeout,
  ]);

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
      // Content-size follow must not gate on `isAutoScrolling`: rapid
      // streaming content-size changes that arrive during the 150ms
      // programmatic-scroll window must still keep the viewport pinned
      // to the bottom. Gating on `!isAutoScrolling` here would silently
      // drop every streaming update that lands inside the debounce
      // window. Bypass `scheduleScrollToLatestMessage` (which keeps
      // the `!isAutoScrolling` guard for the initial itemCount /
      // handleListLayout triggers) and trigger the programmatic scroll
      // directly.
      if (
        shouldFollowSessionContentSize({
          isUserScrolling: isUserScrollingRef.current,
          shouldAutoScroll: shouldAutoScrollRef.current,
          didContentHeightChange,
          isPrepend: growthRef.current === 'prepend',
        })
      ) {
        scrollToLatestMessage();
      }
    },
    [scrollToLatestMessage]
  );

  const handleListLayout = useCallback(() => {
    if (
      shouldScheduleSessionAutoScroll({
        isAutoScrolling: isAutoScrollingRef.current,
        isUserScrolling: isUserScrollingRef.current,
        shouldAutoScroll: shouldAutoScrollRef.current,
      })
    ) {
      scheduleScrollToLatestMessage();
    }
  }, [scheduleScrollToLatestMessage]);

  const handleKeyboardShow = useCallback(() => {
    // Reuse the guarded scheduler so a keyboard opening never yanks the list
    // back to the bottom when the user has scrolled away. The guard inside
    // `scheduleScrollToLatestMessage` honours the follow, user-scroll, and
    // in-flight programmatic-scroll refs.
    scheduleScrollToLatestMessage();
  }, [scheduleScrollToLatestMessage]);

  return {
    isAtBottom,
    listRef,
    scrollToLatestAnimated,
    handleContentSizeChange,
    handleKeyboardShow,
    handleListLayout,
    handleScroll,
    handleScrollBeginDrag,
    handleScrollEndDrag,
    handleMomentumScrollBegin,
    handleMomentumScrollEnd,
  };
}
