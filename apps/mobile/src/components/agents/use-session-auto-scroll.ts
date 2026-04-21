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
    scrollToLatestMessage();

    const retryTimeout = autoScrollRetryTimeoutRef.current;
    if (retryTimeout) {
      clearTimeout(retryTimeout);
    }

    autoScrollRetryTimeoutRef.current = setTimeout(() => {
      autoScrollRetryTimeoutRef.current = null;
      if (shouldAutoScrollRef.current) {
        scrollToLatestMessage();
      }
    }, 80);
  }, [scrollToLatestMessage]);

  useEffect(() => {
    shouldAutoScrollRef.current = true;
    lastContentHeightRef.current = 0;
  }, [resetKey]);

  useEffect(() => {
    if (itemCount > 0 && shouldAutoScrollRef.current) {
      scheduleScrollToLatestMessage();
    }
  }, [itemCount, scheduleScrollToLatestMessage]);

  useEffect(
    () => () => {
      clearAutoScrollResetTimeout();
      const retryTimeout = autoScrollRetryTimeoutRef.current;
      if (retryTimeout) {
        clearTimeout(retryTimeout);
      }
    },
    [clearAutoScrollResetTimeout]
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
    isAutoScrollingRef.current = false;
    clearAutoScrollResetTimeout();
  }, [clearAutoScrollResetTimeout]);

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      const didContentHeightChange = height !== lastContentHeightRef.current;
      lastContentHeightRef.current = height;
      if (shouldAutoScrollRef.current && didContentHeightChange) {
        scheduleScrollToLatestMessage();
      }
    },
    [scheduleScrollToLatestMessage]
  );

  const handleListLayout = useCallback(() => {
    if (shouldAutoScrollRef.current) {
      scheduleScrollToLatestMessage();
    }
  }, [scheduleScrollToLatestMessage]);

  return {
    flatListRef,
    handleContentSizeChange,
    handleListLayout,
    handleScroll,
    handleScrollBeginDrag,
  };
}
