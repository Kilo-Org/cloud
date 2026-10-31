import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Budget for a manual-review start to settle before the screen stops showing
 * the busy button and offers the retry. Matches the client control-plane
 * deadline (`CONTROL_PLANE_DEADLINE_MS`), so the watchdog fires only when the
 * transport deadline has also run out or a slow response is still hanging.
 */
export const MANUAL_REVIEW_START_DEADLINE_MS = 15_000;

/**
 * A settled failure of the watched start: the localized copy the screen
 * renders and whether sending the same request again can succeed. A refusal
 * the user cannot fix by resending drops the retry control, so the screen
 * offers one way forward.
 */
export type WatchedStartFailure = {
  message: string;
  retryable: boolean;
};

/** The state a deadline-watched start exposes to its screen. */
export type DeadlineWatchedStart = {
  /** True while the watched operation is pending and the deadline has not fired. */
  isPending: boolean;
  /** The deadline fired: the start has not settled within its budget. */
  stalled: boolean;
  /** The settled failure, or null when the attempt succeeded or is still out. */
  failure: WatchedStartFailure | null;
};

/**
 * Watch one start-at-a-time async operation with a UI deadline.
 *
 * `isPendingNow` reports the operation's own in-flight state (a mutation's
 * `isPending`, a hook's in-flight flag); the screen's busy button reads
 * `isPending = isPendingNow && !stalled`, so the watchdog — not the closure
 * over the flag — is what releases the button at the deadline. `run`
 * receives a `settle` callback the caller invokes when the operation
 * settles: `settle(null)` marks success, `settle(failure)` records the
 * failure copy the screen renders inline and whether it can be retried.
 * `settle` reports whether it published: a withdrawn attempt's late settle
 * returns false, so the caller's own side effects (navigating to the review,
 * ending an intent) stay bound to the attempt that started them. The watchdog is re-armed on every
 * `begin` and cleared on settle or unmount. When the deadline fires while
 * the operation is still out, `stalled` flips true and the button releases,
 * but the operation itself keeps running, so a late success still lands.
 *
 * `begin` reports whether it admitted the attempt (the caller's own gate may
 * refuse before anything is pending; the watchdog then never arms).
 *
 * `reset` withdraws the failure of the attempt in flight: the caller invokes it
 * when the input that produced that attempt changes, so the feedback and its
 * retry describe the current input only. The withdrawn attempt's own settle is
 * ignored, while the deadline watch it started keeps running, so a request
 * that outlives its budget still releases the action. An operation that still
 * succeeds reports through the caller's own callback.
 */
export function useDeadlineWatchedStart(
  deadlineMs: number,
  isPendingNow: () => boolean,
  run: (settle: (failure: WatchedStartFailure | null) => boolean) => boolean
): DeadlineWatchedStart & { begin: () => void; reset: () => void } {
  const [stalled, setStalled] = useState(false);
  const [failure, setFailure] = useState<WatchedStartFailure | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The attempt that armed the watch in `watchdogRef`. A withdrawn attempt's
  // late settle may only end the watch it started, never a newer attempt's.
  const watchdogAttemptRef = useRef<number | null>(null);
  // Identity of the newest armed attempt. A delayed attempt's settle runs
  // against this token: only the newest attempt may clear the watchdog and
  // publish its result, so a retry is never disarmed or overwritten by a
  // previous attempt's late outcome.
  const attemptRef = useRef(0);
  const clearWatchdog = useCallback((attempt?: number) => {
    if (watchdogRef.current === null) {
      return;
    }
    if (attempt !== undefined && watchdogAttemptRef.current !== attempt) {
      return;
    }
    clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
    watchdogAttemptRef.current = null;
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
    setFailure(null);
    clearWatchdog();
    const settle = (settled: WatchedStartFailure | null): boolean => {
      if (attemptRef.current !== attempt) {
        // The input this attempt describes moved on, so its result must not
        // be published. Its own deadline watch ends with it; a newer
        // attempt's watch is left alone.
        if (watchdogAttemptRef.current !== null && watchdogAttemptRef.current !== attempt) {
          return false;
        }
        clearWatchdog();
        setStalled(false);
        return false;
      }
      clearWatchdog(attempt);
      setStalled(false);
      setFailure(settled);
      return true;
    };
    if (!run(settle)) {
      // The gate refused before anything was pending: no watchdog, and this
      // attempt's settle must never fire.
      attemptRef.current += 1;
      return;
    }
    watchdogAttemptRef.current = attempt;
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null;
      watchdogAttemptRef.current = null;
      // The start has not settled within its budget. Stop showing the busy
      // button and offer the retry; the operation itself keeps running, so a
      // late success still lands.
      setStalled(true);
    }, deadlineMs);
  }, [clearWatchdog, deadlineMs, run]);

  const reset = useCallback(() => {
    // Withdraw the attempt in flight: bumping the token makes its pending
    // settle unable to publish a result for input it no longer describes, and
    // the failure it reported goes with it. The deadline watch stays armed,
    // because the request it watches is still running and the action must
    // still be released when the budget runs out. The stall copy is not
    // withdrawn for the same reason: it describes the wait, not the draft.
    attemptRef.current += 1;
    setFailure(null);
  }, []);

  return {
    begin,
    reset,
    // Read at render time from the caller's getter: a mutation's isPending
    // flips in the same commit that re-renders this hook, so the direct call
    // is current without a ref round-trip.
    isPending: isPendingNow() && !stalled,
    stalled,
    failure,
  };
}
