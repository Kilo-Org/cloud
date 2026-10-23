/**
 * Pure page-collection helpers shared by unfiltered and search paging.
 *
 * No React, no react-query — callers compose these into their own
 * `useMemo` blocks so the test suite can exercise dedupe and
 * page-flattening without pulling in the native bridge.
 */

import { hasRetentionBudget } from '@/lib/query/infinite-retention';
import { dedupeBy } from '@/lib/query/dedupe-by-id';

/**
 * Retention bound for the session-history infinite queries.
 *
 * The history browser pages the stored-sessions query forward and the user
 * scrolls back over everything already loaded. The shared
 * `INFINITE_QUERY_MAX_PAGES` (5) is too small for that: the newest rows sit in
 * page one, and React Query's `maxPages` trim drops index 0 on a forward fetch,
 * so past the bound the head of the list would leave the cache and the list
 * could never scroll back to it. Both paging callers therefore refuse the page
 * after this bound (`sessionNextPageParam`) instead of relying on the trim:
 * page one always stays cached and the list simply stops paging at the bound.
 *
 * `maxPages` also bounds a single refetch: React Query re-requests every page
 * retained in the cache on `refetch()`. The foreground and refresh paths
 * reconcile page one instead, but the bound still caps the fan-out of any full
 * refetch and the memory the history holds.
 */
export const SESSION_HISTORY_MAX_PAGES = 20;

/**
 * Next page cursor for the newest-first session queries. The stored history and
 * the search results share one rule: keep paging while the retained pages fit
 * the bound, then end the cursor chain so the newest page is never trimmed.
 */
export function sessionNextPageParam<TCursor>(
  lastPage: { nextCursor: TCursor },
  pages: readonly unknown[]
): NonNullable<TCursor> | undefined {
  if (!hasRetentionBudget(pages.length, SESSION_HISTORY_MAX_PAGES)) {
    return undefined;
  }
  return lastPage.nextCursor ?? undefined;
}

/**
 * Dedupe sessions by `session_id`, keeping the first occurrence.
 * Does not mutate the input array.
 */
export function dedupeBySessionId<T extends { session_id: string }>(sessions: T[]): T[] {
  return dedupeBy(sessions, session => session.session_id);
}

/**
 * Collect and dedupe sessions by `session_id` across unfiltered
 * cursor-paginated pages (each page has `cliSessions`).
 *
 * The dedupe is needed because a session updated while a page is
 * still loading can repeat in a later page when the cursor follows
 * the sorted timestamp.
 */
export function collectUnfilteredPages<T extends { session_id: string }>(
  pages: { cliSessions: T[] }[] | undefined
): T[] {
  const sessions: T[] = [];
  if (!pages) {
    return sessions;
  }
  for (const page of pages) {
    for (const session of page.cliSessions) {
      sessions.push(session);
    }
  }
  return dedupeBySessionId(sessions);
}

/**
 * Collect and dedupe sessions by `session_id` across search pages
 * (each page has `results`). Pages are appended in order so earlier
 * pages keep their first-seen rows.
 */
export function collectSearchPages<T extends { session_id: string }>(
  pages: { results: T[] }[] | undefined
): T[] {
  const sessions: T[] = [];
  if (!pages) {
    return sessions;
  }
  for (const page of pages) {
    for (const session of page.results) {
      sessions.push(session);
    }
  }
  return dedupeBySessionId(sessions);
}

/**
 * True when the caller should fetch another page.
 *
 * Gates:
 * - No more pages to fetch (`hasNextPage !== true`).
 * - A page fetch is already in flight (`isFetchingNextPage`).
 * - The current data is stale `keepPreviousData` that does not match the
 *   committed query (`isPlaceholderData`). This prevents loading the wrong
 *   page before the fresh results arrive.
 *
 * Unfiltered lists have no placeholder concept (`isPlaceholderData` is
 * always `false`), so only the first two gates apply.
 */
export function shouldLoadMoreSessions(params: {
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  isPlaceholderData: boolean;
}): boolean {
  return params.hasNextPage === true && !params.isFetchingNextPage && !params.isPlaceholderData;
}
