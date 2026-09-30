/**
 * Loading decision shared by the stored session-list surfaces (the history
 * screen and any other surface that renders the same stored rows).
 *
 * React Query v5's `isLoading` is `isPending && isFetching`, so it is false on
 * the first render — the observer has not started the fetch yet — and while a
 * query is paused (offline). The body surfaces gate their empty/error states on
 * this flag, so keying "no data yet" off `isFetching` lets a cold open paint
 * "No past sessions" for a frame before the request settles.
 *
 * `isPending` stays true until the query settles (success or error), which is
 * exactly the "keep showing skeletons until the request settles" contract. It
 * is false as soon as any page is cached, so a background refetch never blanks
 * out rows that are already rendered. A *paused* query is the exception: it
 * never settles offline, so it is treated as settled here and the body offers
 * a retry.
 */
export function selectSessionListIsLoading(input: {
  /** Query inputs (org, persisted filters, identity) have resolved. */
  ready: boolean;
  isSearching: boolean;
  /** `search.isPending` — no search result cached yet. */
  searchIsPending: boolean;
  /** `stored.isPending` — no stored page cached yet. */
  storedIsPending: boolean;
  /**
   * `isPaused` for whichever query `isSearching` selects. React Query pauses
   * an offline query (`networkMode: 'online'`), and `isPending` stays true for
   * the whole pause, so a paused cold open would otherwise render skeletons
   * that never resolve — no rows, no empty state, no retry. Treating it as
   * settled lets the body show its retryable error instead.
   */
  isPaused: boolean;
}): boolean {
  if (!input.ready) {
    return true;
  }
  const isPending = input.isSearching ? input.searchIsPending : input.storedIsPending;
  return isPending && !input.isPaused;
}
