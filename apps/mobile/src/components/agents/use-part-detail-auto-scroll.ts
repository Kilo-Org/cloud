import { useCallback, useEffect, useRef } from 'react';
import { type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView } from 'react-native';

import {
  isSessionListAtBottom,
  shouldFollowSessionContentSize,
  shouldScheduleSessionAutoScroll,
} from './use-session-auto-scroll-state';

type UsePartDetailAutoScrollParams = {
  /** True only while the sheet shows a streaming reasoning part. */
  enabled: boolean;
  /** Flips on sheet open/close; each flip resets the follow state to "at bottom". */
  resetKey: string;
};

/**
 * ScrollView companion to `useSessionListAutoScroll` for the part detail
 * sheet: follow content growth while the user is at the bottom, stop on
 * drag or momentum, resume when the user returns to the bottom. Decisions
 * live in `use-session-auto-scroll-state`; this hook only wires ScrollView
 * events to refs, so streaming ticks cause no re-render churn. Unlike the
 * FlashList hook there is no 80ms retry: a plain ScrollView
 * `scrollToEnd({ animated: false })` lands in one frame. The
 * `isAutoScrollingRef` guard is kept: a scroll event emitted by the
 * programmatic follow (or landing between two rapid content growths) can
 * report a not-at-bottom offset, and without the guard it would silently
 * turn follow off mid-stream.
 */
export function usePartDetailAutoScroll({ enabled, resetKey }: UsePartDetailAutoScrollParams) {
  const scrollRef = useRef<ScrollView>(null);
  const shouldAutoScrollRef = useRef(true);
  const isAutoScrollingRef = useRef(false);
  const isUserScrollingRef = useRef(false);
  const lastContentHeightRef = useRef(0);
  const autoScrollResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userScrollingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAutoScrollResetTimeout = useCallback(() => {
    const timeout = autoScrollResetTimeoutRef.current;
    if (timeout) {
      clearTimeout(timeout);
      autoScrollResetTimeoutRef.current = null;
    }
  }, []);

  const clearUserScrollingTimeout = useCallback(() => {
    const timeout = userScrollingTimeoutRef.current;
    if (timeout) {
      clearTimeout(timeout);
      userScrollingTimeoutRef.current = null;
    }
  }, []);

  const scrollToLatest = useCallback(() => {
    isAutoScrollingRef.current = true;
    clearAutoScrollResetTimeout();
    scrollRef.current?.scrollToEnd({ animated: false });
    autoScrollResetTimeoutRef.current = setTimeout(() => {
      isAutoScrollingRef.current = false;
      autoScrollResetTimeoutRef.current = null;
    }, 150);
  }, [clearAutoScrollResetTimeout]);

  useEffect(() => {
    shouldAutoScrollRef.current = true;
    isAutoScrollingRef.current = false;
    isUserScrollingRef.current = false;
    lastContentHeightRef.current = 0;
  }, [resetKey]);

  useEffect(
    () => () => {
      clearAutoScrollResetTimeout();
      clearUserScrollingTimeout();
    },
    [clearAutoScrollResetTimeout, clearUserScrollingTimeout]
  );

  const updateFromEvent = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    shouldAutoScrollRef.current = isSessionListAtBottom({
      contentHeight: contentSize.height,
      viewportHeight: layoutMeasurement.height,
      offsetY: contentOffset.y,
    });
  }, []);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (isAutoScrollingRef.current) {
        return;
      }
      updateFromEvent(event);
    },
    [updateFromEvent]
  );

  const handleScrollBeginDrag = useCallback(() => {
    isUserScrollingRef.current = true;
    isAutoScrollingRef.current = false;
    clearAutoScrollResetTimeout();
    clearUserScrollingTimeout();
  }, [clearAutoScrollResetTimeout, clearUserScrollingTimeout]);

  const handleScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      updateFromEvent(event);
      // onMomentumScrollEnd is not guaranteed for short or slow drags, so a
      // fallback clear keeps isUserScrollingRef from sticking at true.
      // onMomentumScrollBegin cancels it when a real fling starts.
      clearUserScrollingTimeout();
      userScrollingTimeoutRef.current = setTimeout(() => {
        isUserScrollingRef.current = false;
        userScrollingTimeoutRef.current = null;
      }, 100);
    },
    [clearUserScrollingTimeout, updateFromEvent]
  );

  const handleMomentumScrollBegin = useCallback(() => {
    clearUserScrollingTimeout();
  }, [clearUserScrollingTimeout]);

  const handleMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      clearUserScrollingTimeout();
      isUserScrollingRef.current = false;
      updateFromEvent(event);
    },
    [clearUserScrollingTimeout, updateFromEvent]
  );

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      const didContentHeightChange = height !== lastContentHeightRef.current;
      lastContentHeightRef.current = height;
      if (!enabled) {
        return;
      }
      if (
        shouldFollowSessionContentSize({
          isUserScrolling: isUserScrollingRef.current,
          shouldAutoScroll: shouldAutoScrollRef.current,
          didContentHeightChange,
        })
      ) {
        scrollToLatest();
      }
    },
    [enabled, scrollToLatest]
  );

  // Pins the first paint to the bottom when the modal shows: onLayout fires
  // when the ScrollView's own frame settles, even if no content-size change
  // is delivered for the already-present text.
  const handleLayout = useCallback(() => {
    if (!enabled) {
      return;
    }
    if (
      shouldScheduleSessionAutoScroll({
        isAutoScrolling: isAutoScrollingRef.current,
        isUserScrolling: isUserScrollingRef.current,
        shouldAutoScroll: shouldAutoScrollRef.current,
      })
    ) {
      scrollToLatest();
    }
  }, [enabled, scrollToLatest]);

  return {
    scrollRef,
    handleScroll,
    handleScrollBeginDrag,
    handleScrollEndDrag,
    handleMomentumScrollBegin,
    handleMomentumScrollEnd,
    handleContentSizeChange,
    handleLayout,
  };
}
