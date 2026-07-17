import { type FlashListRef } from '@shopify/flash-list';
import { useCallback, useEffect, useRef } from 'react';
import { type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import {
  isSessionListAtBottom,
  SESSION_LIST_BOTTOM_THRESHOLD_PX,
  shouldFollowSessionContentSize,
  shouldRetrySessionAutoScroll,
  shouldScheduleSessionAutoScroll,
} from '@/components/agents/use-session-auto-scroll-state';

type UseSessionListAutoScrollParams = {
  itemCount: number;
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
  resetKey,
}: UseSessionListAutoScrollParams) {
  const listRef = useRef<FlashListRef<ItemT>>(null);
  const shouldAutoScrollRef = useRef(true);
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
    shouldAutoScrollRef.current = true;
    lastContentHeightRef.current = 0;
  }, [resetKey]);

  useEffect(() => {
    if (itemCount > 0 && shouldAutoScrollRef.current && !isUserScrollingRef.current) {
      scheduleScrollToLatestMessage();
    }
  }, [itemCount, scheduleScrollToLatestMessage]);

  useEffect(
    () => () => {
      clearAutoScrollResetTimeout();
      clearAutoScrollRetryTimeout();
      clearUserScrollingTimeout();
    },
    [clearAutoScrollResetTimeout, clearAutoScrollRetryTimeout, clearUserScrollingTimeout]
  );

  const updateAutoScrollFromEvent = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      shouldAutoScrollRef.current = isSessionListAtBottom({
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
        offsetY: contentOffset.y,
        thresholdPx: SESSION_LIST_BOTTOM_THRESHOLD_PX,
      });
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

  return {
    listRef,
    handleContentSizeChange,
    handleListLayout,
    handleScroll,
    handleScrollBeginDrag,
    handleScrollEndDrag,
    handleMomentumScrollBegin,
    handleMomentumScrollEnd,
  };
}
