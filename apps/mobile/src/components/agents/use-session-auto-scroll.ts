import { useCallback, useEffect, useRef } from 'react';
import { type FlatList, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

type UseSessionAutoScrollParams = {
  itemCount: number;
  resetKey: string;
};

export function useSessionAutoScroll<ItemT>({ itemCount, resetKey }: UseSessionAutoScrollParams) {
  const flatListRef = useRef<FlatList<ItemT>>(null);
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

  const scrollToLatestMessage = useCallback(() => {
    isAutoScrollingRef.current = true;
    clearAutoScrollResetTimeout();
    flatListRef.current?.scrollToOffset({
      offset: lastContentHeightRef.current,
      animated: false,
    });
    autoScrollResetTimeoutRef.current = setTimeout(() => {
      isAutoScrollingRef.current = false;
      autoScrollResetTimeoutRef.current = null;
    }, 150);
  }, [clearAutoScrollResetTimeout]);

  const scheduleScrollToLatestMessage = useCallback(() => {
    if (isUserScrollingRef.current) {
      return;
    }
    scrollToLatestMessage();
    clearAutoScrollRetryTimeout();
    autoScrollRetryTimeoutRef.current = setTimeout(() => {
      autoScrollRetryTimeoutRef.current = null;
      if (shouldAutoScrollRef.current && !isUserScrollingRef.current) {
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
    },
    [clearAutoScrollResetTimeout, clearAutoScrollRetryTimeout]
  );

  const updateAutoScrollFromEvent = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
      shouldAutoScrollRef.current = distanceFromBottom < 100;
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
  }, [clearAutoScrollResetTimeout, clearAutoScrollRetryTimeout]);

  const handleScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      updateAutoScrollFromEvent(event);
    },
    [updateAutoScrollFromEvent]
  );

  const handleMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      isUserScrollingRef.current = false;
      updateAutoScrollFromEvent(event);
    },
    [updateAutoScrollFromEvent]
  );

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      const didContentHeightChange = height !== lastContentHeightRef.current;
      lastContentHeightRef.current = height;
      if (shouldAutoScrollRef.current && didContentHeightChange && !isUserScrollingRef.current) {
        scheduleScrollToLatestMessage();
      }
    },
    [scheduleScrollToLatestMessage]
  );

  const handleListLayout = useCallback(() => {
    if (shouldAutoScrollRef.current && !isUserScrollingRef.current) {
      scheduleScrollToLatestMessage();
    }
  }, [scheduleScrollToLatestMessage]);

  return {
    flatListRef,
    handleContentSizeChange,
    handleListLayout,
    handleScroll,
    handleScrollBeginDrag,
    handleScrollEndDrag,
    handleMomentumScrollEnd,
  };
}
