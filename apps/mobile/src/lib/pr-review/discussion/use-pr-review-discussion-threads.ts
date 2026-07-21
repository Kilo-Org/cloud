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

import { useInfiniteQuery } from '@tanstack/react-query';

import { classifyPrReviewQueryState } from '@/lib/pr-review/classify-pr-review-query-state';
import { useTRPC } from '@/lib/trpc';

export function usePrReviewDiscussionThreads(args: {
  owner: string;
  repo: string;
  number: number;
}) {
  const { owner, repo, number } = args;
  const trpc = useTRPC();
  const query = useInfiniteQuery(
    trpc.githubPrReview.listReviewThreads.infiniteQueryOptions(
      { owner, repo, number },
      {
        staleTime: 15_000,
        getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
      }
    )
  );

  const hasLoadedPages = (query.data?.pages.length ?? 0) > 0;
  const firstPagePending = query.isPending;
  const firstPageErrorState =
    !firstPagePending && !hasLoadedPages && query.error
      ? classifyPrReviewQueryState(query.error)
      : null;
  const laterPageError = Boolean(query.error) && hasLoadedPages;

  // Flat list of all threads across all loaded pages, in page order.
  // We return a fresh array on every render so the consumer can
  // `.map` without memoizing; the rows themselves are stable.
  const threads = (query.data?.pages ?? []).flatMap(page => page.threads);

  return {
    query,
    threads,
    firstPageErrorState,
    laterPageError,
  };
}
