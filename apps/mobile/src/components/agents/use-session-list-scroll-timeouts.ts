import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react';

type Timeout = ReturnType<typeof setTimeout>;

/**
 * One transcript scroller's three timers: the programmatic-scroll window, the
 * follow retry, and the drag's reclaim window.
 *
 * They belong together because they outlive the callbacks that start them and a
 * scroller that goes away must leave none of them firing: the mount owns all
 * three, clears any of them on demand, and clears every one on unmount.
 */
export function useSessionListScrollTimeouts() {
  const resetRef = useRef<Timeout | null>(null);
  const retryRef = useRef<Timeout | null>(null);
  const userScrollingRef = useRef<Timeout | null>(null);
  const clear = useCallback((ref: RefObject<Timeout | null>) => {
    const timeout = ref.current;
    if (timeout !== null) {
      clearTimeout(timeout);
      ref.current = null;
    }
  }, []);
  const clearReset = useCallback(() => {
    clear(resetRef);
  }, [clear, resetRef]);
  const clearRetry = useCallback(() => {
    clear(retryRef);
  }, [clear, retryRef]);
  const clearUserScrolling = useCallback(() => {
    clear(userScrollingRef);
  }, [clear, userScrollingRef]);

  useEffect(
    () => () => {
      clearReset();
      clearRetry();
      clearUserScrolling();
    },
    [clearReset, clearRetry, clearUserScrolling]
  );

  return useMemo(
    () => ({ resetRef, retryRef, userScrollingRef, clearReset, clearRetry, clearUserScrolling }),
    [clearReset, clearRetry, clearUserScrolling]
  );
}
