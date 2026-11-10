import { useEffect, useRef, useState } from 'react';

/** How long a read may sit idle with nothing in flight before it is restarted. */
const IDLE_LOAD_RETRY_DELAY_MS = 2500;

export type IdleLoadRetry = {
  /** The automatic restart already ran and the read is still not fetching. */
  exhausted: boolean;
  /** Restart the read by hand and re-arm the automatic attempt. */
  retry: () => void;
};

/**
 * Restarts a read that is pending with no data and no fetch (`fetchStatus:
 * 'idle'`), and reports when even that restart did not get it running.
 *
 * This is the one state a query can sit in with nothing running and nothing
 * failed: react-query reverts a cancelled first fetch to it
 * (`Query.cancel({ revert: true })`), and a subscriber that survives the
 * cancel is never notified again, so no effect of the query itself would ever
 * fire. The timer is therefore armed from this hook, not from a query
 * callback, and bumping its attempt state re-renders the caller — which is
 * also what re-attaches a subscriber whose query was dropped from the cache
 * while it was mounted.
 *
 * The automatic attempt happens exactly once per cycle: a read that is still
 * idle after it cannot start on its own, so the caller shows the error with
 * Retry instead of waiting behind a spinner forever.
 */
export function useIdleLoadRetry(input: { idle: boolean; refetch: () => void }): IdleLoadRetry {
  const [attempts, setAttempts] = useState(0);
  const refetchReference = useRef(input.refetch);
  refetchReference.current = input.refetch;

  const exhausted = input.idle && attempts > 0;
  useEffect(() => {
    if (!input.idle || attempts > 0) {
      return undefined;
    }
    const timer = setTimeout(() => {
      // The attempt state is bumped before the refetch so the render it
      // schedules re-attaches the subscriber, and the refetch covers a query
      // that is only idle. Both land in the same tick: the next render reads
      // the `fetching` status the refetch sets synchronously, so the skipped
      // state never paints an error.
      setAttempts(1);
      refetchReference.current();
    }, IDLE_LOAD_RETRY_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [input.idle, attempts]);

  const retry = () => {
    // A fresh cycle: the manual attempt gets the same single automatic retry
    // if it also leaves the read idle.
    setAttempts(0);
    refetchReference.current();
  };

  return { exhausted, retry };
}
