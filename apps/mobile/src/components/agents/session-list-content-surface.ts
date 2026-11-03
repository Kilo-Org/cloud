/**
 * Pure surface decision for the session-list body. Encodes the
 * single-render-site contract:
 *  - Keep one FlashList mounted through initial skeleton → rows.
 *  - Full-screen errors settle after loading, but stay visible with a busy Retry
 *    control during the refetch.
 *  - History-empty renders only after loading completes.
 *  - ListEmptyComponent prefers skeletons while loading over any body-empty
 *    kind (avoids flashing "No past sessions" mid-load).
 *  - A stored-list failure with only stale cached rows shows the full-screen
 *    error when rows were not delivered by this screen's own load. Rows
 *    delivered this mount keep rendering with the inline refresh error.
 */
type SessionListContentSurface =
  | { kind: 'full-screen-error' }
  | { kind: 'history-empty' }
  | { kind: 'session-list'; listEmpty: 'loading-skeletons' | 'body-empty' | 'none' };

export function selectSessionListContentSurface(input: {
  isLoading: boolean;
  isError: boolean;
  isRetrying: boolean;
  hasAnySessions: boolean;
  hasHistoryContent: boolean;
  hasActiveQuery: boolean;
  /** True when the stored query delivered rows since this screen mounted. */
  hasFreshHistory: boolean;
}): SessionListContentSurface {
  const {
    isLoading,
    isError,
    isRetrying,
    hasAnySessions,
    hasHistoryContent,
    hasActiveQuery,
    hasFreshHistory,
  } = input;

  // Gate non-list surfaces on !isLoading so a cold open (empty cache for the
  // whole load) cannot flash history-empty or full-screen error.
  //
  // Two ways to land here: nothing to fall back on at all, or cached rows from
  // an earlier mount that this screen's own load could not confirm. Keep that
  // error visible while Retry is pending: React Query can temporarily report a
  // non-error status during the refetch, but those cached rows are still stale.
  // An active search/filter owns its own error body (Retry + Clear).
  if (
    (isRetrying && !hasActiveQuery && !hasFreshHistory) ||
    (!isLoading && isError && (!hasAnySessions || (!hasActiveQuery && !hasFreshHistory)))
  ) {
    return { kind: 'full-screen-error' };
  }
  // No stored rows and no active query: render the history-empty body (the
  // screen gates its search chrome on `hasAnySessions` and renders this
  // full-screen).
  if (!isLoading && !hasAnySessions) {
    return { kind: 'history-empty' };
  }

  if (isLoading) {
    return { kind: 'session-list', listEmpty: 'loading-skeletons' };
  }
  if (!hasHistoryContent) {
    return { kind: 'session-list', listEmpty: 'body-empty' };
  }
  return { kind: 'session-list', listEmpty: 'none' };
}
