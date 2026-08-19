import { type QueryClient } from '@tanstack/react-query';
import { InteractionManager } from 'react-native';

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
 * Trim every matching infinite query to page one, then invalidate the same
 * prefix so the retained page is refetched.
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
    if (typeof old !== 'object' || old === null || !('pages' in old)) {
      return old;
    }
    const data = old as { pages: unknown[]; pageParams: unknown[] };
    return {
      ...old,
      pages: data.pages.slice(0, 1),
      pageParams: data.pageParams.slice(0, 1),
    };
  });
  void queryClient.invalidateQueries({ queryKey: queryKeyPrefix });
}

/**
 * Run cache maintenance after the current interactions settle, so a
 * navigation frame never waits on it.
 */
export function scheduleCacheMaintenance(run: () => void): void {
  // eslint-disable-next-line typescript-eslint/no-deprecated -- InteractionManager.runAfterInteractions is the documented API for deferring work past the current interaction frame.
  InteractionManager.runAfterInteractions(run);
}
