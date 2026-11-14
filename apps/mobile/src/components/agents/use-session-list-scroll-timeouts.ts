import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react';

type Timeout = ReturnType<typeof setTimeout>;

/**
 * How long a released drag waits for its momentum end before the drag counts as
 * settled: `onMomentumScrollEnd` is not guaranteed for a short or slow drag.
 */
export const DRAG_SETTLE_MS = 100;

/**
 * How long a fling may report nothing before its motion is considered over. A
 * momentum end can be dropped by the platform, and motion that never ends would
 * disable every scheduled resume scroll for the rest of the screen.
 */
export const MOMENTUM_BOUND_MS = 2000;

/**
 * One transcript scroller's timers and the fact of whether it is moving.
 *
 * The programmatic-scroll window, the follow retry and the drag settle belong
 * together because they outlive the callbacks that start them, and a scroller
 * that goes away must leave none of them firing.
 *
 * Motion lives here because it has one writer. Every path that ends motion —
 * the momentum end, a drag that ends without one, a fling that never reports
 * its end, a session reset and unmount — clears it through `endMotion`, so it
 * cannot be left true by a missing native event.
 */
export function useSessionListScrollTimeouts() {
  const resetRef = useRef<Timeout | null>(null);
  const retryRef = useRef<Timeout | null>(null);
  const motionRef = useRef(false);
  const motionTimeoutRef = useRef<Timeout | null>(null);
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
  const endMotion = useCallback(() => {
    clear(motionTimeoutRef);
    motionRef.current = false;
  }, [clear, motionTimeoutRef]);
  /** The user put a finger down, or a fling is running: the list is moving. */
  const beginMotion = useCallback(() => {
    motionRef.current = true;
  }, [motionRef]);
  /**
   * Motion ends after `ms` unless something ends it first. `onSettled` runs at
   * that moment too, so the claim a drag leaves behind settles on the same
   * timer that ends its motion.
   */
  const settleMotion = useCallback(
    (ms: number, onSettled?: () => void) => {
      clear(motionTimeoutRef);
      motionTimeoutRef.current = setTimeout(() => {
        motionTimeoutRef.current = null;
        motionRef.current = false;
        onSettled?.();
      }, ms);
    },
    [clear, motionTimeoutRef]
  );

  useEffect(
    () => () => {
      clearReset();
      clearRetry();
      endMotion();
    },
    [clearReset, clearRetry, endMotion]
  );

  return useMemo(
    () => ({
      resetRef,
      retryRef,
      motionRef,
      clearReset,
      clearRetry,
      beginMotion,
      settleMotion,
      endMotion,
    }),
    [clearReset, clearRetry, beginMotion, settleMotion, endMotion, motionRef]
  );
}
