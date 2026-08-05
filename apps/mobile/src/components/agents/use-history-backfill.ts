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
