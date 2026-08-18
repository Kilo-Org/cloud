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
 * Replace only the matching entities across every loaded page of one
 * infinite query, without refetching.
 *
 * Pages with no match and entities that do not match keep their exact object
 * reference. The top-level data object is also returned unchanged when
 * nothing matches, so unrelated subscribers never see a new reference.
 */
export function patchInfiniteEntity<TPage, TEntity>(args: {
  queryClient: QueryClient;
  queryKey: readonly unknown[];
  selectItems: (page: TPage) => TEntity[];
  replaceItems: (page: TPage, items: TEntity[]) => TPage;
  matches: (entity: TEntity) => boolean;
  update: (entity: TEntity) => TEntity;
}): void {
  const { queryClient, queryKey, selectItems, replaceItems, matches, update } = args;

  queryClient.setQueryData(queryKey, old => {
    if (typeof old !== 'object' || old === null || !('pages' in old)) {
      return old;
    }
    const data = old as { pages: TPage[] };
    const nextPages: TPage[] = [];
    let changed = false;
    for (const page of data.pages) {
      const items = selectItems(page);
      const nextItems: TEntity[] = [];
      let pageChanged = false;
      for (const item of items) {
        if (matches(item)) {
          pageChanged = true;
          nextItems.push(update(item));
        } else {
          nextItems.push(item);
        }
      }
      if (pageChanged) {
        changed = true;
        nextPages.push(replaceItems(page, nextItems));
      } else {
        nextPages.push(page);
      }
    }
    if (!changed) {
      return old;
    }
    return { ...data, pages: nextPages };
  });
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
