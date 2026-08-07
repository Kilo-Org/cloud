// Pure (react/react-native-free) selectors for the Agents search busy
// indicator and effective search query gate. Extracted so the four
// interaction states (debounce window, first fetch, refinement with
// previous data, and clear-X) can be unit tested without DOM or timers.

/**
 * True while typed text is ahead of the committed (debounced) query.
 * `lastTyped.trim()` mirrors the controller's `text.trim()` so trailing
 * whitespace does not stick the flag.
 */
export function selectAwaitingCommit(params: {
  hasText: boolean;
  lastTyped: string;
  searchQuery: string;
}): boolean {
  return params.hasText && params.lastTyped.trim() !== params.searchQuery;
}

/**
 * True when the in-field search spinner should replace the search icon.
 *
 * Covers three windows:
 * - debounce window (typed text not yet committed) — `awaitingCommit`
 * - first fetch with no previous data — `isSearching && isFetching`,
 *   where `isPending` is also true but `isFetching` is the single
 *   signal that works for all three fetch shapes
 * - refinement fetch under `keepPreviousData` — `isPending` false,
 *   `isFetching` true
 *
 * Same-key refetches and retries (isFetching true, isPending false,
 * isPlaceholderData false) are also covered.
 */
export function selectShowSearchBusy(params: {
  awaitingCommit: boolean;
  isSearching: boolean;
  isFetching: boolean;
}): boolean {
  return params.awaitingCommit || (params.isSearching && params.isFetching);
}

/**
 * Effective search query to feed the body and tray narrowing.
 *
 * During the FIRST fetch for a new search text (when `keepPreviousData`
 * has no previous data to fall back on, so `isPending` is true), the
 * body should render as if no search were applied — otherwise blank
 * placeholders flash. Once previous data exists, the stale result set
 * stays visible while `isFetching` drives the indicator instead.
 */
export function selectEffectiveSearchQuery(params: {
  isSearching: boolean;
  isPending: boolean;
  searchQuery: string;
}): string {
  return params.isSearching && params.isPending ? '' : params.searchQuery;
}
