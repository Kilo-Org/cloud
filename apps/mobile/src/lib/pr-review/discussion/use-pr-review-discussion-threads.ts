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
import { withInfiniteRetention } from '@/lib/query/infinite-retention';
import { useTRPC } from '@/lib/trpc';

/**
 * Build the discussion-threads infinite-query options. Kept as a pure builder
 * so the retention bound is testable without mounting the hook.
 */
export function buildPrReviewDiscussionThreadsQueryOptions(
  trpc: ReturnType<typeof useTRPC>,
  args: { owner: string; repo: string; number: number }
) {
  const { owner, repo, number } = args;
  return withInfiniteRetention(
    trpc.githubPrReview.listReviewThreads.infiniteQueryOptions(
      { owner, repo, number },
      {
        staleTime: 15_000,
        getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
      }
    )
  );
}

/**
 * Keep the first-page conversation comments across the retention trim.
 *
 * The backend returns conversation comments on the first page only; later
 * pages carry `conversation: []`. Once `maxPages` trims the oldest page,
 * `pages[0]` is no longer the first page, so reading `pages[0].conversation`
 * would erase the comments. Prefer the current first page's conversation when
 * it is non-empty; otherwise fall back to the retained value.
 */
export function retainConversation<C>(
  pages: readonly { conversation: readonly C[] }[] | undefined,
  retained: readonly C[]
): readonly C[] {
  const first = pages?.[0]?.conversation;
  return first && first.length > 0 ? first : retained;
}

// Module-level retention store. Keyed by the PR identity so the retained
// first-page conversation survives the tab's unmount/remount cycle, which
// a component ref cannot.
const conversationRetention = new Map<string, readonly ConversationComment[]>();

function conversationRetentionKey(args: { owner: string; repo: string; number: number }): string {
  return `${args.owner}/${args.repo}#${args.number}`;
}

/**
 * Read and update the retained first-page conversation for one PR.
 *
 * Prefer the current first page's conversation when it is non-empty;
 * otherwise fall back to the previously retained value. Writes the value
 * back when it changed so a later mount (over the trimmed cache) still
 * reads it.
 */
export function retainConversationAcrossMounts(
  key: string,
  pages: readonly { conversation: readonly ConversationComment[] }[] | undefined
): readonly ConversationComment[] {
  const retained = conversationRetention.get(key) ?? [];
  const conversation = retainConversation(pages, retained);
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
  const query = useInfiniteQuery(
    buildPrReviewDiscussionThreadsQueryOptions(trpc, { owner, repo, number })
  );

  const hasLoadedPages = (query.data?.pages.length ?? 0) > 0;
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
  const pages = query.data?.pages;
  const threads = useMemo(() => (pages ?? []).flatMap(page => page.threads), [pages]);

  // Conversation comments live only on the first page. Retention trims the
  // oldest page once the bound is exceeded, which would erase the comments if
  // we read `pages[0]` directly. Keep the last non-empty conversation in a
  // module-level store keyed by the PR identity so it survives both the trim
  // and the tab's unmount/remount cycle.
  const conversation = retainConversationAcrossMounts(
    conversationRetentionKey({ owner, repo, number }),
    pages
  );

  return {
    query,
    threads,
    conversation,
    firstPageErrorState,
    laterPageError,
  };
}
