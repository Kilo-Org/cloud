import { useCallback, useEffect, useRef, useState } from 'react';

/** The watchdog's caller-facing controls and state. */
export type AttemptWatchdog = {
  /** Starts (or restarts) the deadline for the current attempt. */
  arm: () => void;
  /** Clears an armed timer without marking a timeout. */
  disarm: () => void;
  /** The deadline fired for the current attempt. */
  timedOut: boolean;
  /** Clears the timeout mark so a follow-up attempt is watched fresh. */
  resetTimeout: () => void;
};

/**
 * One-at-a-time attempt watchdog: `arm` starts the deadline for the current
 * attempt, `timedOut` reports that the deadline fired (the caller releases
 * its busy flag and renders its inline retryable failure), `disarm` clears
 * an armed timer without marking a timeout, and a fresh `arm` resets the
 * flag. The timer is also cleared on unmount.
 *
 * The callback runs with no in-flight guard: the closure would read the
 * pre-attempt state, and the timer is disarmed whenever the attempt settles
 * before the deadline.
 */
export function useAttemptWatchdog(deadlineMs: number, onTimeout: () => void): AttemptWatchdog {
  const [timedOut, setTimedOut] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTimeoutRef = useRef(onTimeout);
  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  }, [onTimeout]);
  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  useEffect(() => clear, [clear]);
  const arm = useCallback(() => {
    clear();
    setTimedOut(false);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setTimedOut(true);
      onTimeoutRef.current();
    }, deadlineMs);
  }, [clear, deadlineMs]);
  const disarm = useCallback(() => {
    clear();
  }, [clear]);
  const resetTimeout = useCallback(() => {
    setTimedOut(false);
  }, []);
  return { arm, disarm, timedOut, resetTimeout };
}
