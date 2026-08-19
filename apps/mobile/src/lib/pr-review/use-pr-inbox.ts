// Authorized, paginated PR inbox query hook.
//
// `usePrInbox(enabled)` wraps the tRPC `listInbox` infinite query and
// returns the flat item list plus the same first-page / later-page
// error split the Files and Discussion tabs use. The query string is
// server-fixed (`review-requested:@me`), so the inbox can only ever
// return PRs the caller's own GitHub token can already see.
//
// `buildPrInboxQueryOptions` is a pure builder (the pattern
// `buildStoredSessionsQueryOptions` uses) so the pagination contract is
// executable-tested without mounting the hook.

import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { classifyPrReviewQueryState } from '@/lib/pr-review/classify-pr-review-query-state';
import { useTRPC } from '@/lib/trpc';

// Cap at 20 pages so a pathological inbox cannot walk the GraphQL
// `search` cursor forever (GraphQL search is rate limited more tightly
// than REST; the 30s staleTime plus this cap keep the inbox inside it).
const INBOX_MAX_PAGES = 20;

export function buildPrInboxQueryOptions(trpc: ReturnType<typeof useTRPC>, enabled: boolean) {
  return trpc.githubPrReview.listInbox.infiniteQueryOptions(
    {},
    {
      enabled,
      staleTime: 30_000,
      getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
      maxPages: INBOX_MAX_PAGES,
    }
  );
}

export function usePrInbox(enabled: boolean) {
  const trpc = useTRPC();
  const query = useInfiniteQuery(buildPrInboxQueryOptions(trpc, enabled));

  const errorState = query.error ? classifyPrReviewQueryState(query.error) : null;
  // A first-page error is one where NO page has loaded yet. A failure while
  // fetching a LATER page (already-loaded items present) is a later-page error
  // and must not blank the list — the caller keeps the loaded rows and offers
  // an inline retry instead.
  const hasLoadedPages = (query.data?.pages.length ?? 0) > 0;
  const firstPageErrorState = hasLoadedPages ? null : errorState;
  const laterPageError = Boolean(query.error) && hasLoadedPages;

  const pages = query.data?.pages;
  const items = useMemo(() => (pages ?? []).flatMap(page => page.items), [pages]);

  return {
    query,
    items,
    errorState,
    firstPageErrorState,
    laterPageError,
  };
}
