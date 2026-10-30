import { type Query, type QueryClient } from '@tanstack/react-query';
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
 * Whether an infinite list may load another page under its retention bound.
 *
 * A newest-first list has to reach its bound by refusing the next page, not by
 * letting `maxPages` trim: a forward fetch runs `addToEnd`, which drops index 0
 * of the pages array once the bound is exceeded, and index 0 is page one — the
 * newest page. Fold this into `getNextPageParam` so the cursor ends at the
 * bound, every loaded page stays cached, and the newest rows stay reachable.
 */
export function hasRetentionBudget(
  pageCount: number,
  maxPages: number = INFINITE_QUERY_MAX_PAGES
): boolean {
  return pageCount < maxPages;
}

/**
 * A page-one refetch is one page from the start. `infiniteQueryBehavior` reads
 * the page count from the options, and without it a plain refetch re-requests
 * every retained page (up to the retention bound).
 *
 * The option is only typed on `queryClient.infiniteQuery`, so it joins the
 * fetch options by spread rather than as a written property.
 */
const FIRST_PAGE_ONLY = { pages: 1 };

/** The options of an infinite query, as much as the reconcile reads back. */
const infiniteQueryOptionsSchema = z.looseObject({ initialPageParam: z.unknown() });

/**
 * Whether a cached entry is an infinite query at all, and the start cursor it
 * carries. Only infinite queries have `initialPageParam`; the shared
 * `QueryOptions` type does not declare it, so the property decides. Its value
 * cannot decide on its own: `undefined` is a legitimate page param for a
 * cursor list.
 */
type InitialPageParamProbe = { present: false } | { present: true; value: unknown };

function readInitialPageParam(query: Query): InitialPageParamProbe {
  const options = infiniteQueryOptionsSchema.safeParse(query.options);
  if (!options.success || !('initialPageParam' in options.data)) {
    return { present: false };
  }
  return { present: true, value: options.data.initialPageParam };
}

async function refetchFirstPage(query: Query): Promise<void> {
  try {
    await query.fetch({ ...query.options, ...FIRST_PAGE_ONLY });
  } catch {
    // A failed page-one refetch keeps the retained pages in place. A reconcile
    // is a refresh, and pull-to-refresh or Retry reports the failure; clearing
    // the rows here would make a failed refresh look like an empty list.
  }
}

/**
 * Re-anchor one entry's start cursor and start its page-one refetch.
 *
 * Returns the in-flight refetch, or null when the entry is not a mounted
 * infinite query: a non-infinite entry has no pages to reconcile, and one no
 * list is showing refetches on its next mount instead.
 */
function reconcileEntry(query: Query): Promise<void> | null {
  const data = infiniteQueryDataSchema.safeParse(query.state.data);
  const initialPageParam = readInitialPageParam(query);
  if (!data.success || !initialPageParam.present) {
    return null;
  }
  if (data.data.pageParams.length > 0 && data.data.pageParams[0] !== initialPageParam.value) {
    // Cursor-only rewrite: the rows and their update stamp stay as they are, so
    // nothing reads this as a delivery.
    query.setState({
      data: {
        pages: data.data.pages,
        pageParams: [initialPageParam.value, ...data.data.pageParams.slice(1)],
      },
    });
  }
  return query.observers.length > 0 ? refetchFirstPage(query) : null;
}

/**
 * Refresh page one of every infinite query under `queryKeyPrefix`, keeping the
 * rows already on screen until that page arrives.
 *
 * A plain `invalidateQueries` on an infinite query refetches every retained
 * page (`infiniteQueryBehavior` starts a fetch of the cached page count), so
 * this used to empty `pages`/`pageParams` first and let the invalidate refill
 * page one. An emptied cache is indistinguishable from a successful empty
 * result: any list reading it painted its "nothing here" state while the
 * refetch was paused by lost connectivity or had failed, and replaced the rows
 * the reader was looking at.
 *
 * So a reconcile is a refresh, not a reset:
 *
 * - The cached pages stay, so a list keeps its rows through a paused or failed
 *   refetch.
 * - `pageParams[0]` is re-anchored at `initialPageParam` first. `maxPages`
 *   trims from the front, so once a page was evicted index 0 is no longer page
 *   one, and a refetch started from it would reload the oldest retained page
 *   and replace the newest rows with it.
 * - The prefix is marked stale without refetching it, so an entry no list is
 *   showing refetches on its next mount.
 * - Each mounted entry fetches page one from the start; the pages are replaced
 *   only when that page is delivered.
 *
 * The returned promise settles once the page-one fetches settle, so a caller
 * that needs the refresh finished (pull-to-refresh, foreground resume) can
 * await it.
 */
export async function reconcileFirstPage(
  queryClient: QueryClient,
  queryKeyPrefix: readonly unknown[]
): Promise<void> {
  const entries = queryClient.getQueryCache().findAll({ queryKey: queryKeyPrefix });
  // Mark the prefix stale first: a page-one fetch that succeeds clears its own
  // entry's invalidation, so the rows it delivered are fresh, while an entry no
  // list is showing stays stale and refetches on its next mount.
  await queryClient.invalidateQueries({ queryKey: queryKeyPrefix, refetchType: 'none' });
  const refetches: Promise<void>[] = [];

  for (const query of entries) {
    const refetch = reconcileEntry(query);
    if (refetch !== null) {
      refetches.push(refetch);
    }
  }

  await Promise.all(refetches);
}
