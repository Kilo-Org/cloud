/**
 * Bounded automatic backfill for the "all sessions are active" gap.
 *
 * When active-set exclusion empties every loaded stored page, the body model
 * keeps the list rendered instead of claiming the history is exhausted. This
 * selector decides whether the caller should fetch the next stored page
 * automatically. Every gate must be green:
 *  - `hasPinnedActive` is the populated-tray gate: the backfill exists to
 *    fill history below a viewport-filling tray, so an empty tray (the
 *    unenriched window, covered by the `all-active` body) blocks it.
 *  - `hasHistoryContent` is false when no rendered section survives the
 *    active-set exclusion.
 *  - `hasMoreHistory` is the stored pagination `hasNextPage`.
 *  - `isFetching` (any stored fetch in flight) serializes the backfill behind
 *    focus-return/pull-to-refresh refetches so it never overlaps the same
 *    infinite query; `getNextPageParam` recomputes from the fresh pages after
 *    the refetch completes.
 *  - `isSearching` is the committed search mode (`searchQuery.length > 0`),
 *    not the effective query: during the pending-search window the stored list
 *    stays rendered, but no backfill fires until the user leaves search mode.
 *  - `loadedPageCount` bounds the automatic work explicitly: heartbeat rows
 *    have no server-side cap, so the exclusion-emptied-page count is not
 *    provably bounded without it. After the bound, the body stays `render-list`
 *    (no claim) and manual scroll pagination takes over.
 */

/** Initial page plus at most two automatic backfill fetches per query instance. */
export const MAX_HISTORY_AUTOLOAD_PAGES = 3;

export function shouldBackfillHistoryAfterActiveExclusion(params: {
  hasHistoryContent: boolean;
  hasStoredSessions: boolean;
  hasPinnedActive: boolean;
  hasMoreHistory: boolean | undefined;
  isFetchingNextPage: boolean;
  isFetching: boolean;
  isSearching: boolean;
  isLoading: boolean;
  isError: boolean;
  loadedPageCount: number;
}): boolean {
  return (
    params.hasPinnedActive &&
    !params.hasHistoryContent &&
    params.hasStoredSessions &&
    params.hasMoreHistory === true &&
    !params.isFetchingNextPage &&
    !params.isFetching &&
    !params.isSearching &&
    !params.isLoading &&
    !params.isError &&
    params.loadedPageCount < MAX_HISTORY_AUTOLOAD_PAGES
  );
}
