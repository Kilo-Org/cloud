import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Budget for a manual-review start to settle before the screen stops showing
 * the busy button and offers the retry. Matches the client control-plane
 * deadline (`CONTROL_PLANE_DEADLINE_MS`), so the watchdog fires only when the
 * transport deadline has also run out or a slow response is still hanging.
 */
export const MANUAL_REVIEW_START_DEADLINE_MS = 15_000;

/** The state a deadline-watched start exposes to its screen. */
export type DeadlineWatchedStart = {
  /** True while the watched operation is pending and the deadline has not fired. */
  isPending: boolean;
  /** The deadline fired: the start has not settled within its budget. */
  stalled: boolean;
  /** The settled failure message, or null. */
  failureMessage: string | null;
};

/**
 * Watch one start-at-a-time async operation with a UI deadline.
 *
 * `isPendingNow` reports the operation's own in-flight state (a mutation's
 * `isPending`, a hook's in-flight flag); the screen's busy button reads
 * `isPending = isPendingNow && !stalled`, so the watchdog — not the closure
 * over the flag — is what releases the button at the deadline. `run`
 * receives a `settle` callback the caller invokes when the operation
 * settles: `settle(null)` marks success, `settle(message)` records the
 * failure copy the screen renders inline. The watchdog is re-armed on every
 * `begin` and cleared on settle or unmount. When the deadline fires while
 * the operation is still out, `stalled` flips true and the button releases,
 * but the operation itself keeps running, so a late success still lands.
 *
 * `begin` reports whether it admitted the attempt (the caller's own gate may
 * refuse before anything is pending; the watchdog then never arms).
 */
export function useDeadlineWatchedStart(
  deadlineMs: number,
  isPendingNow: () => boolean,
  run: (settle: (failureMessage: string | null) => void) => boolean
): DeadlineWatchedStart & { begin: () => void } {
  const [stalled, setStalled] = useState(false);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Identity of the newest armed attempt. A delayed attempt's settle runs
  // against this token: only the newest attempt may clear the watchdog and
  // publish its result, so a retry is never disarmed or overwritten by a
  // previous attempt's late outcome.
  const attemptRef = useRef(0);
  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);
  useEffect(() => clearWatchdog, [clearWatchdog]);

  const begin = useCallback(() => {
    // A fresh attempt replaces the previous failure with either the outcome
    // or the new failure state; the watchdog re-arms for it. The settle
    // passed to `run` is bound to this attempt, so a stale attempt's late
    // settle cannot touch the newer one.
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    setStalled(false);
    setFailureMessage(null);
    clearWatchdog();
    const settle = (message: string | null) => {
      if (attemptRef.current !== attempt) {
        return;
      }
      clearWatchdog();
      setStalled(false);
      setFailureMessage(message);
    };
    if (!run(settle)) {
      // The gate refused before anything was pending: no watchdog, and this
      // attempt's settle must never fire.
      attemptRef.current += 1;
      return;
    }
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null;
      // The start has not settled within its budget. Stop showing the busy
      // button and offer the retry; the operation itself keeps running, so a
      // late success still lands.
      setStalled(true);
    }, deadlineMs);
  }, [clearWatchdog, deadlineMs, run]);

  return {
    begin,
    // Read at render time from the caller's getter: a mutation's isPending
    // flips in the same commit that re-renders this hook, so the direct call
    // is current without a ref round-trip.
    isPending: isPendingNow() && !stalled,
    stalled,
    failureMessage,
  };
}
