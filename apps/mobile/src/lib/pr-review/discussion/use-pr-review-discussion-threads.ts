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
// page's conversation in the module-level store in
// `conversation-retention.ts`, keyed by the signed-in tenant and the PR
// identity, so it survives both the retention trim (which drops the oldest
// page once `maxPages` is exceeded) and the tab's unmount/remount cycle
// (`PrReviewScreen` unmounts `PrReviewDiscussionTab` on every tab change,
// which a component ref cannot survive).

import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { classifyPrReviewQueryState } from '@/lib/pr-review/classify-pr-review-query-state';
import {
  conversationRetentionKey,
  retainConversationAcrossMounts,
} from '@/lib/pr-review/discussion/conversation-retention';
import {
  buildPrThreadsQueryOptions,
  normalizePrThreadsPages,
} from '@/lib/pr-review/provider-pr-queries';
import {
  githubPrRef,
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

export function usePrReviewDiscussionThreads(args: {
  owner: string;
  repo: string;
  number: number;
}) {
  const { owner, repo, number } = args;
  const trpc = useTRPC();
  const scope = useProviderPrScope({ owner, repo, number });
  // The tenant the discussion read runs under. `getMe` is already cached for
  // every signed-in surface (both PR route layouts read it), so this adds no
  // request; it is read here because the retention store is process-wide and
  // its key must name the account, not only the PR.
  const { userId } = useCurrentUserId();
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
  // The key carries the signed-in account and organization as well as the ref,
  // so a remount can only ever be served the conversation its own tenant read;
  // while the account is still unknown the store is neither read nor written.
  const conversation = retainConversationAcrossMounts(
    userId === undefined
      ? null
      : conversationRetentionKey({ userId, organizationId: scope.organizationId, ref: scope.ref }),
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
