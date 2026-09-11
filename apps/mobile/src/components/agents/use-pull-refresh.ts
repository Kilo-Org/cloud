import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Ceiling on how long a pull keeps the native spinner and the in-flight
 * "Updating" line. The pull owns gesture feedback, not the refetch lifecycle:
 * a hung fetch (a dead server that never answers) must hand off to the inline
 * "Couldn't refresh" + Retry within this budget instead of pinning the
 * spinner through the whole retry ladder.
 */
export const PULL_FEEDBACK_BUDGET_MS = 15_000;

/**
 * Short anti-flicker floor on how long a rejected pull keeps the in-flight
 * feedback before the failure line takes over. A connection-refused refetch
 * settles in well under a second; swapping "Updating" out that fast makes the
 * in-flight state a sub-second flash the reader can miss entirely (device
 * defect e1-updating). Hold the spinner and the visible line through the
 * beat, then swap. The beat stays short: once the refresh has failed, the
 * failure line's Retry action must not wait on it — readers catch "Updating"
 * during the genuinely in-flight pull, not after the rejection.
 */
export const PULL_FEEDBACK_MIN_BEAT_MS = 800;

/**
 * A refetch's settlement: exactly `false` reports a rejected refresh (the live
 * tab's wrapped refetch does). A surface whose refetch resolves without a
 * boolean (the history screen's) maps its void resolution to `true` and
 * reports failures through the query error state instead.
 */
export type PullRefetch = () => Promise<boolean>;

export type PullRefresh = {
  /** Native pull-to-refresh spinner is shown. */
  refreshing: boolean;
  /** A retry (no native spinner) is in flight; the status line owns feedback. */
  busy: boolean;
  /** The last pull/retry failed or is past the feedback budget. */
  failed: boolean;
  startPull: () => void;
  startRetry: () => void;
  /**
   * A refresh outside the pull lifecycle (a focus return or app-foreground
   * refetch the surface runs directly) settled on an accepted result: the
   * list is up to date, so a still-standing pull-failure line is stale and
   * must retire. Never touches in-flight feedback — a pull that is running
   * keeps its own spinner, beat, and settlement.
   */
  markSettled: () => void;
};

/**
 * Pull/retry state machine shared by the Agents list surfaces. `refetch`
 * resolves when the underlying fetches settle; a `false` settlement reports a
 * rejected refresh. A refresh that is still in flight past the feedback budget
 * stops the spinner and hands over to the failure line, so a hung fetch can
 * never pin the spinner with no next action (device defect e1). A rejection
 * that lands fast holds the in-flight feedback through the minimum beat first,
 * so "Updating" is perceivable before "Couldn't refresh" replaces it.
 */
export function usePullRefresh(refetch: PullRefetch): PullRefresh {
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const tokenRef = useRef(0);
  const budgetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    for (const timerRef of [budgetTimerRef, settleTimerRef]) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
  }, []);

  const run = useCallback(
    (withSpinner: boolean) => {
      const token = (tokenRef.current += 1);
      const startedAt = Date.now();
      clearTimers();
      setFailed(false);
      // A new run supersedes any in-flight one: reset both feedback flags to
      // this run's mode. The dead run's settlement is token-guarded and can
      // never clear its own flag, so without this reset a pull over a retry
      // pins busy (and a retry over a pull pins the spinner) after the new
      // run settles — "Updating" forever, no Retry, no spinner.
      setRefreshing(withSpinner);
      setBusy(!withSpinner);
      const stopFeedback = () => {
        setRefreshing(false);
        setBusy(false);
      };
      const applySettlement = (rejected: boolean) => {
        if (token !== tokenRef.current) {
          return;
        }
        clearTimers();
        stopFeedback();
        setFailed(rejected);
      };
      void (async () => {
        let rejected = true;
        try {
          rejected = !(await refetch());
        } catch {
          rejected = true;
        }
        if (token !== tokenRef.current) {
          return;
        }
        // An accepted refresh settles immediately. A rejection that lands
        // fast holds the in-flight feedback through the beat, so "Updating"
        // is perceivable before "Couldn't refresh" replaces it; a superseding
        // pull/retry (new token) cancels the pending swap.
        if (!rejected) {
          applySettlement(false);
          return;
        }
        const wait = Math.max(0, PULL_FEEDBACK_MIN_BEAT_MS - (Date.now() - startedAt));
        if (wait === 0) {
          applySettlement(rejected);
          return;
        }
        settleTimerRef.current = setTimeout(() => {
          settleTimerRef.current = null;
          applySettlement(rejected);
        }, wait);
      })();
      budgetTimerRef.current = setTimeout(() => {
        if (token !== tokenRef.current) {
          return;
        }
        budgetTimerRef.current = null;
        // Still in flight past the budget: the spinner stops and the failure
        // line takes over. The late settlement above can still clear it.
        stopFeedback();
        setFailed(true);
      }, PULL_FEEDBACK_BUDGET_MS);
    },
    [clearTimers, refetch]
  );

  useEffect(() => clearTimers, [clearTimers]);

  const startPull = useCallback(() => {
    run(true);
  }, [run]);
  const startRetry = useCallback(() => {
    run(false);
  }, [run]);
  const markSettled = useCallback(() => {
    setFailed(false);
  }, []);

  return { refreshing, busy, failed, startPull, startRetry, markSettled };
}
