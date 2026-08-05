/**
 * Pure page-collection helpers shared by unfiltered and search paging.
 *
 * No React, no react-query — callers compose these into their own
 * `useMemo` blocks so the test suite can exercise dedupe and
 * page-flattening without pulling in the native bridge.
 */

/**
 * Dedupe sessions by `session_id`, keeping the first occurrence.
 * Does not mutate the input array.
 */
export function dedupeBySessionId<T extends { session_id: string }>(sessions: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const session of sessions) {
    if (!seen.has(session.session_id)) {
      seen.add(session.session_id);
      result.push(session);
    }
  }
  return result;
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
