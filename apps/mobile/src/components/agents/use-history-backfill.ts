import { useEffect } from 'react';

type UseHistoryBackfillParams = {
  /**
   * True when the backfill selector (see `shouldBackfillHistoryAfterActiveExclusion`)
   * wants the next stored history page fetched automatically. The selector is
   * the single source of truth for the gates (search, loading, error, in-flight
   * fetches, page bound), so this hook itself stays a one-decision effect.
   */
  shouldBackfill: boolean;
  /**
   * The stored pagination fetch. React Query memoizes `fetchNextPage`, so with
   * a stable reference the effect runs once per false-to-true transition of
   * `shouldBackfill` — exactly one page per qualifying change. The promise is
   * intentionally discarded (fire-and-forget), and keeping this a prop lets
   * the mounted test drive it with a mock.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- fire-and-forget callback; real callers pass a union of differently-shaped fetchNextPage functions (search vs. stored query), so a generic type param collapses to `void` at the call site instead of unifying.
  fetchNextPage: () => Promise<unknown>;
};

/**
 * Executes the bounded automatic backfill for the "all sessions are active"
 * gap. When the selector flips `shouldBackfill` to true, fetches the next
 * stored page. The selector flips it back to false while that fetch is in
 * flight (`isFetchingNextPage`/`isFetching`), so backfill never overlaps the
 * same infinite query, and stops permanently at the loaded-page bound.
 */
export function useHistoryBackfill({
  shouldBackfill,
  fetchNextPage,
}: UseHistoryBackfillParams): void {
  useEffect(() => {
    if (shouldBackfill) {
      void fetchNextPage();
    }
  }, [shouldBackfill, fetchNextPage]);
}

/**
 * Runs an operation only after the previously enqueued one has settled
 * (resolved or rejected). `useAgentSessions` shares one coordinator between
 * the stored list's `fetchNextPage` and its `refetch`, so a backfill fetch
 * can never overlap a focus-return/pull-to-refresh/retry refetch on the same
 * infinite query, and vice versa. The backfill selector's `isFetching` gate
 * only observes the previous render, so the backfill effect and the focus
 * effect can fire in the same commit before React Query sets its in-flight
 * flags — this coordinator closes that gap. A rejected operation never
 * wedges the queue.
 */
type OperationCoordinator = <T>(operation: () => Promise<T>) => Promise<T>;

async function awaitSettled(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // Swallow — sequencing only; the caller observes the real outcome.
  }
}

export function createOperationCoordinator(): OperationCoordinator {
  let tail: Promise<unknown> | undefined = undefined;
  // eslint-disable-next-line typescript-eslint/require-await -- the await lives inside the nested IIFE so the tail is registered synchronously, before the next caller chains behind it (same pattern as chainSave)
  return async operation => {
    const previous = tail;
    const next = (async () => {
      if (previous) {
        await previous;
      }
      return operation();
    })();
    tail = awaitSettled(next);
    return next;
  };
}
