import { type QueryClient } from '@tanstack/react-query';
import * as z from 'zod';

const infiniteQueryDataSchema = z.looseObject({
  pages: z.array(z.unknown()),
  pageParams: z.array(z.unknown()),
});

/**
 * The default number of pages an infinite query keeps in memory.
 *
 * Bounded retention keeps long-lived session and findings lists from growing
 * without limit while a user pages through them.
 */
export const INFINITE_QUERY_MAX_PAGES = 5;

/**
 * Merge the retention bound into an infinite-query options object.
 *
 * Returns the same options with a numeric `maxPages` added, so every
 * in-scope owner states the same retention contract.
 */
export function withInfiniteRetention<T extends object>(
  options: T,
  maxPages: number = INFINITE_QUERY_MAX_PAGES
): T & { maxPages: number } {
  return { ...options, maxPages };
}

/**
 * Reset every matching infinite query to empty, then invalidate the same
 * prefix so page one is refetched from `initialPageParam`.
 *
 * The reset empties `pages`/`pageParams` rather than keeping `pages[0]`:
 * after `maxPages` evicts the oldest page from the front of the array,
 * `pages[0]` is no longer page one, so keeping it would refetch the wrong
 * cursor. Invalidate then refills page one from `initialPageParam`.
 *
 * Uses `setQueriesData` (plural) on purpose: callers hold an invalidate
 * prefix while the live cache keys carry the query input as well, so
 * `setQueryData` on the prefix would match nothing.
 *
 * A non-infinite entry under the prefix is left untouched by the
 * `'pages' in old` guard.
 */
export function reconcileFirstPage(
  queryClient: QueryClient,
  queryKeyPrefix: readonly unknown[]
): void {
  queryClient.setQueriesData({ queryKey: queryKeyPrefix }, old => {
    const parsed = infiniteQueryDataSchema.safeParse(old);
    if (!parsed.success) {
      return old;
    }
    return {
      ...parsed.data,
      pages: [],
      pageParams: [],
    };
  });
  void queryClient.invalidateQueries({ queryKey: queryKeyPrefix });
}
