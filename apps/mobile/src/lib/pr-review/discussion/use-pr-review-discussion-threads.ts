// Discussion-tab list query hook.
//
//   - `usePrReviewDiscussionThreads` — wraps the tRPC
//     `listReviewThreads` infinite query and returns the tab-level
//     error classification (via `classifyPrReviewQueryState`) so
//     the tab can short-circuit to a terminal state when the FIRST
//     page fails (a later-page error is rare here but should be
//     surfaced as a "Retry" affordance, not a tab-level blank).
//
// `useInfiniteQuery` returns `error` for both first-page and later-
// page errors. A first-page error is one where `pages.length === 0`
// AND the query has finished (no longer `isPending`). The
// `firstPageErrorState` helper below encodes that distinction so
// the tab UI doesn't have to.
//
// Conversation comments are returned on the first page only (backend
// contract: later pages carry `conversation: []`). We retain the first
// page's conversation in a module-level store keyed by the PR identity so
// it survives both the retention trim (which drops the oldest page once
// `maxPages` is exceeded) and the tab's unmount/remount cycle
// (`PrReviewScreen` unmounts `PrReviewDiscussionTab` on every tab change,
// which a component ref cannot survive).

import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { classifyPrReviewQueryState } from '@/lib/pr-review/classify-pr-review-query-state';
import { type ConversationComment } from '@/lib/pr-review/discussion/review-discussion-types';
import {
  buildPrThreadsQueryOptions,
  normalizePrThreadsPages,
} from '@/lib/pr-review/provider-pr-queries';
import {
  githubPrRef,
  providerPrRefKey,
  type ProviderPrScope,
  useProviderPrScope,
} from '@/lib/pr-review/provider-pr-ref';
import { withInfiniteRetention } from '@/lib/query/infinite-retention';
import { useTRPC } from '@/lib/trpc';

/**
 * Build the discussion-threads infinite-query options. Kept as a pure builder
 * so the retention bound is testable without mounting the hook.
 *
 * The provider is decided by `scope`; without one the caller is on the GitHub
 * route and this is the `listReviewThreads` query that route always ran.
 */
export function buildPrReviewDiscussionThreadsQueryOptions(
  trpc: ReturnType<typeof useTRPC>,
  args: { owner: string; repo: string; number: number; scope?: ProviderPrScope }
) {
  const { owner, repo, number } = args;
  const scope = args.scope ?? { ref: githubPrRef(owner, repo, number), organizationId: null };
  return withInfiniteRetention(buildPrThreadsQueryOptions(trpc, scope));
}

/**
 * Fallback used once the retention trim has evicted page one.
 *
 * The backend returns conversation comments on the first page only; later
 * pages carry `conversation: []`. Once `maxPages` trims the oldest page,
 * `pages[0]` is no longer the first page, so reading `pages[0].conversation`
 * would erase the comments. Prefer the current first page's conversation when
 * it is non-empty; otherwise fall back to the retained value. While page one
 * IS loaded the caller uses its value directly (see
 * `retainConversationAcrossMounts`), including when it is empty.
 */
export function retainConversation<C>(
  pages: readonly { conversation: readonly C[] }[] | undefined,
  retained: readonly C[]
): readonly C[] {
  const first = pages?.[0]?.conversation;
  return first && first.length > 0 ? first : retained;
}

// Module-level retention store. Keyed by the provider ref so the retained
// first-page conversation survives the tab's unmount/remount cycle (which a
// component ref cannot) and so two same-named repositories on different
// providers never share one entry.
const conversationRetention = new Map<string, readonly ConversationComment[]>();

// Shared empty reference so an empty first page keeps a stable identity across
// renders instead of a fresh `[]` literal on every call.
const EMPTY_CONVERSATION: readonly ConversationComment[] = [];

/**
 * Read and update the retained first-page conversation for one PR.
 *
 * `firstPageLoaded` tells the two cases apart. When the live first page is
 * loaded (`pages[0]` is page one), it is the source of truth — including when
 * it is empty, so deleting the last conversation comment empties the
 * discussion and a later eviction still reads that empty truth. Only once the
 * retention trim has evicted page one (later pages carry `conversation: []` by
 * backend contract) does the retained copy become the source, so the comments
 * survive the trim and the tab's unmount/remount cycle.
 */
export function retainConversationAcrossMounts(
  key: string,
  pages: readonly { conversation: readonly ConversationComment[] }[] | undefined,
  firstPageLoaded: boolean
): readonly ConversationComment[] {
  const retained = conversationRetention.get(key) ?? EMPTY_CONVERSATION;
  const conversation = firstPageLoaded
    ? (pages?.[0]?.conversation ?? EMPTY_CONVERSATION)
    : retainConversation(pages, retained);
  if (conversation !== retained) {
    conversationRetention.set(key, conversation);
  }
  return conversation;
}

export function usePrReviewDiscussionThreads(args: {
  owner: string;
  repo: string;
  number: number;
}) {
  const { owner, repo, number } = args;
  const trpc = useTRPC();
  const scope = useProviderPrScope({ owner, repo, number });
  const query = useInfiniteQuery(
    buildPrReviewDiscussionThreadsQueryOptions(trpc, { owner, repo, number, scope })
  );

  const hasLoadedPages = (query.data?.pages.length ?? 0) > 0;
  // Neither arm sets `initialPageParam`, so page one's `pageParam` is
  // `undefined`, and the retention trim evicts `pages` and `pageParams`
  // together. `pageParams[0] === undefined` therefore holds exactly when
  // `pages[0]` is page one — the signal that tells the live-first-page case
  // apart from the evicted one.
  const firstPageLoaded = hasLoadedPages && query.data?.pageParams[0] === undefined;
  const firstPagePending = query.isPending;
  const firstPageErrorState =
    !firstPagePending && !hasLoadedPages && query.error
      ? classifyPrReviewQueryState(query.error)
      : null;
  const laterPageError = Boolean(query.error) && hasLoadedPages;

  // Flat list of all threads across all loaded pages, in page order.
  // Ordering for display is applied by `mergeDiscussionListItems` in
  // the tab (full re-sort of the entire loaded set).
  // Memoized so identity changes only when page data changes (RQ
  // structural sharing keeps `pages` stable across unrelated re-renders).
  // Provider pages arrive in the provider's own shape; normalizing here is
  // what lets the tab render one list for all three providers.
  const platform = scope.ref.platform;
  const rawPages = query.data?.pages;
  const pages = useMemo(() => normalizePrThreadsPages(platform, rawPages), [platform, rawPages]);
  const threads = useMemo(() => pages.flatMap(page => page.threads), [pages]);

  // Conversation comments live only on the first page. Retention trims the
  // oldest page once the bound is exceeded, which would erase the comments if
  // we read `pages[0]` directly. While page one is loaded it is the truth
  // (including an empty one, so a deleted last comment empties the
  // discussion); once it is evicted, the module-level store keeps the last
  // first-page value across both the trim and the tab's unmount/remount cycle.
  const conversation = retainConversationAcrossMounts(
    providerPrRefKey(scope.ref),
    pages,
    firstPageLoaded
  );

  return {
    query,
    threads,
    conversation,
    firstPageErrorState,
    laterPageError,
  };
}
