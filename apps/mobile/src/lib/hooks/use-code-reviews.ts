import { useEffect, useMemo } from 'react';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { hasInFlightReview, isInFlightReviewStatus } from '@kilocode/app-shared/code-review';
import { type inferRouterInputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { PERSONAL_SCOPE } from '@/lib/hooks/use-code-reviewer';
import { withInfiniteRetention } from '@/lib/query/infinite-retention';
import { trpcClient, useTRPC } from '@/lib/trpc';

function isPersonal(scope: string) {
  return scope === PERSONAL_SCOPE;
}

export const REVIEW_PAGE_SIZE = 50;

/**
 * Retention bound for the review-list infinite query.
 *
 * The list is browsed by scroll, so a bounded window of pages keeps the
 * browsable range reachable. The bound matters most on invalidation and app
 * foreground: a refetch of an infinite query re-requests every retained page,
 * so the page count is what caps that burst. Ten pages of 50 reviews is far more
 * than a user scrolls back through, while still stopping an unbounded history
 * from accumulating for the life of the screen.
 *
 * `listCodeReviews` orders `created_at desc`, so page one is the NEWEST page.
 * React Query's `maxPages` trims the front element on a forward fetch
 * (`addToEnd(..., maxPages)`), which would evict the newest reviews from the top
 * of the list. `buildReviewListQueryOptions` therefore also stops forward paging
 * at this bound, so the bound is reached by refusing the next page and `maxPages`
 * never has to trim.
 */
export const REVIEW_LIST_MAX_PAGES = 10;

/** Poll cadence for page one while a review on it is still running. */
const REVIEW_POLL_INTERVAL_MS = 5000;

/** Child segment that keeps the page-one probe under the list's invalidate prefix. */
const REVIEW_FIRST_PAGE_KEY = 'firstPage';

type ReviewListPage = Awaited<ReturnType<typeof trpcClient.codeReviews.listForUser.query>>;

type ReviewListData = InfiniteData<ReviewListPage, number>;

/** Fetch one page of the recent-reviews list at `offset` (personal or org scope). */
async function fetchReviewListPage(scope: string, offset: number): Promise<ReviewListPage> {
  const page = isPersonal(scope)
    ? await trpcClient.codeReviews.listForUser.query({ limit: REVIEW_PAGE_SIZE, offset })
    : await trpcClient.codeReviews.listForOrganization.query({
        organizationId: scope,
        limit: REVIEW_PAGE_SIZE,
        offset,
      });
  return page;
}

/**
 * The review-list query key for `scope` — exactly the key `useInvalidateReviews`
 * invalidates and the key the list infinite query is stored under.
 */
export function buildReviewListQueryKey(trpc: ReturnType<typeof useTRPC>, scope: string) {
  return isPersonal(scope)
    ? trpc.codeReviews.listForUser.queryKey()
    : trpc.codeReviews.listForOrganization.queryKey({ organizationId: scope });
}

/**
 * Build the review-list infinite-query options. Kept as a pure builder so the
 * offset paging is testable without mounting the hook. The query key is exactly
 * the key `useInvalidateReviews` invalidates, so cancel/retrigger/foreground
 * invalidation keeps matching (invalidation is prefix-based).
 *
 * Deliberately not tRPC's `infiniteQueryOptions`: it injects `{ cursor }`, which
 * this offset-based schema does not read.
 *
 * The in-flight poll is deliberately NOT here: React Query's interval runs a
 * full `refetch`, which for an infinite query re-requests every retained page
 * (see `buildReviewFirstPageQueryOptions`).
 */
export function buildReviewListQueryOptions(trpc: ReturnType<typeof useTRPC>, scope: string) {
  return withInfiniteRetention(
    {
      queryKey: buildReviewListQueryKey(trpc, scope),
      initialPageParam: 0,
      queryFn: async ({ pageParam }: { pageParam: number }): Promise<ReviewListPage> => {
        const page = await fetchReviewListPage(scope, pageParam);
        // The list endpoints resolve handler errors as `{ success: false, error }`
        // instead of throwing (no tRPC client link converts them). Reject here so
        // React Query marks the page as an error: a failed first page drives the
        // screen's transient QueryError, and a failed next page drives the retry
        // footer via `isFetchNextPageError` while keeping the loaded rows.
        if (!page.success) {
          throw new Error(page.error);
        }
        return page;
      },
      getNextPageParam: (
        lastPage: ReviewListPage,
        pages: ReviewListPage[],
        lastPageParam: number
      ) =>
        lastPage.success && lastPage.hasMore && pages.length < REVIEW_LIST_MAX_PAGES
          ? lastPageParam + lastPage.reviews.length
          : undefined,
    },
    REVIEW_LIST_MAX_PAGES
  );
}

/**
 * Build the page-one probe used while a review is in flight. It fetches offset 0
 * only, so one poll tick is one request instead of one per retained page; the
 * result is merged back into the list cache by `useReviewList`.
 *
 * The key is a child of the list key, so `useInvalidateReviews` and the
 * route-level `[['codeReviews']]` foreground invalidate still refresh the probe
 * along with the list.
 */
export function buildReviewFirstPageQueryOptions(
  trpc: ReturnType<typeof useTRPC>,
  scope: string,
  enabled: boolean
) {
  return {
    queryKey: [...buildReviewListQueryKey(trpc, scope), REVIEW_FIRST_PAGE_KEY],
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    queryFn: (): Promise<ReviewListPage> => fetchReviewListPage(scope, 0),
    staleTime: 0,
    enabled,
    refetchInterval: (query: { state: { data?: ReviewListPage } }) => {
      const page = query.state.data;
      if (!page?.success) {
        return false;
      }
      return hasInFlightReview(page.reviews) ? REVIEW_POLL_INTERVAL_MS : false;
    },
  };
}

/**
 * Whether the probe's fresh page one holds the same rows, in the same order, as
 * the cached page one — i.e. replacing it cannot shift the page-one/page-two
 * boundary.
 *
 * `listCodeReviews` orders `created_at desc`, so a review added or removed at
 * the top shifts every later page's offset by one. `mergeReviewFirstPage` keeps
 * `pageParams` and the later pages, so a changed row set would skip the row that
 * moved across the boundary, and `dedupeById` cannot recover a gap (the row is
 * simply absent, not duplicated). When the row set changed the caller refetches
 * the retained pages instead, re-requesting every page at its offset.
 */
export function reviewFirstPageBoundaryMatches(
  existing: ReviewListData | undefined,
  page: ReviewListPage | undefined
): boolean {
  const cachedFirst = existing?.pages[0];
  if (!cachedFirst?.success || !page?.success) {
    return false;
  }
  return (
    cachedFirst.reviews.length === page.reviews.length &&
    cachedFirst.reviews.every((review, index) => review.id === page.reviews[index]?.id)
  );
}

/**
 * What the page-one probe should do with its fresh page. Pure so the decision is
 * unit-testable.
 *
 * `merge` swaps page one in place. `refetch` is for the shifted-boundary case:
 * with more than one retained page, a changed row set means every later page
 * starts at a stale offset, so the retained pages are refetched (each at its own
 * param) instead of skipping the row that moved across the boundary. A single
 * retained page has no boundary to desync — the next page param is recomputed
 * from the new page one — so it always merges.
 */
export function selectReviewFirstPageAction(
  existing: ReviewListData | undefined,
  page: ReviewListPage | undefined
): 'merge' | 'refetch' {
  if (!page?.success) {
    return 'merge';
  }
  if (existing && existing.pages.length > 1 && !reviewFirstPageBoundaryMatches(existing, page)) {
    return 'refetch';
  }
  return 'merge';
}

/**
 * Replace page one of a cached review list with a fresh page. Pure so the merge
 * is unit-testable. Returns `existing` unchanged when there is no cache, no
 * page one, or the incoming page failed — pageParams and later pages are kept.
 *
 * The `pageParams[0] === 0` guard keeps the write on the first page. It is also
 * the guard that would no-op the merge if page one were ever evicted from the
 * front; `buildReviewListQueryOptions` caps forward paging at
 * `REVIEW_LIST_MAX_PAGES` so that cannot happen on this list.
 */
export function mergeReviewFirstPage(
  existing: ReviewListData | undefined,
  page: ReviewListPage | undefined
): ReviewListData | undefined {
  if (!existing || existing.pages.length === 0 || existing.pageParams[0] !== 0 || !page?.success) {
    return existing;
  }
  return { ...existing, pages: [page, ...existing.pages.slice(1)] };
}

export function useReviewList(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const list = useInfiniteQuery(buildReviewListQueryOptions(trpc, scope));

  // The list's own first page is what the screen renders, so it decides whether
  // a review is still in flight and a page-one probe is worth running at all.
  const firstPage = list.data?.pages[0];
  const probing = firstPage?.success === true && hasInFlightReview(firstPage.reviews);
  const probe = useQuery(buildReviewFirstPageQueryOptions(trpc, scope, probing));

  // Memoised: the builder returns a fresh array on every call, and the effect
  // below must not re-run every render because of a new key reference.
  const listKey = useMemo<readonly unknown[]>(
    () => buildReviewListQueryKey(trpc, scope),
    [trpc, scope]
  );
  // React Query memoizes `refetch`, but the result object is fresh each render;
  // listing the method keeps the effect from re-running on every render.
  const listRefetch = list.refetch;

  useEffect(() => {
    const page = probe.data;
    if (!page?.success) {
      return;
    }
    const existing = queryClient.getQueryData<ReviewListData>(listKey);
    if (selectReviewFirstPageAction(existing, page) === 'refetch') {
      // The probe's page one holds a different row set, so the retained later
      // pages start at stale offsets. Re-request every retained page at its
      // offset (`cancelRefetch: false` joins an in-flight refetch instead of
      // cancelling and re-issuing it) so the list stays contiguous.
      void listRefetch({ cancelRefetch: false });
      return;
    }
    queryClient.setQueryData<ReviewListData>(listKey, current =>
      mergeReviewFirstPage(current, page)
    );
  }, [probe.data, queryClient, listKey, listRefetch]);

  return list;
}

export function useReviewDetail(reviewId: string) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.codeReviews.get.queryOptions({ reviewId }),
    refetchInterval: query => {
      const data = query.state.data;
      if (!data?.success) {
        return false;
      }
      return isInFlightReviewStatus(data.review.status) ? 5000 : false;
    },
  });
}

function useInvalidateReviews(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listQueryKey = isPersonal(scope)
    ? trpc.codeReviews.listForUser.queryKey()
    : trpc.codeReviews.listForOrganization.queryKey({ organizationId: scope });
  return (reviewId?: string) => {
    void queryClient.invalidateQueries({ queryKey: listQueryKey });
    if (reviewId) {
      void queryClient.invalidateQueries({ queryKey: trpc.codeReviews.get.queryKey({ reviewId }) });
    }
  };
}

export async function cancelReviewMutationFn(vars: { reviewId: string }) {
  // `success` is typed as `boolean` (not a `true` literal), so a domain
  // failure here must not be treated as a resolved mutation — throwing
  // routes it to onError (toast) instead of letting callers' onSuccess
  // fire haptics/navigation as if it worked. The error carries the
  // server's `data.error` verbatim so toast.error(error.message) shows
  // the domain reason instead of a generic literal.
  const result = await trpcClient.codeReviews.cancel.mutate({ reviewId: vars.reviewId });
  if (!result.success) {
    throw new Error(result.error);
  }
  return result;
}

export function useCancelReview(scope: string) {
  const invalidateReviews = useInvalidateReviews(scope);

  return useMutation({
    mutationFn: cancelReviewMutationFn,
    onSuccess: (_data, vars) => {
      invalidateReviews(vars.reviewId);
    },
    onError: error => {
      announcingToast.error(error.message);
    },
  });
}

export async function retriggerReviewMutationFn(vars: { reviewId: string }) {
  // Same typed-error pattern as cancelReviewMutationFn: a domain failure throws
  // so React Query runs onError (toast) rather than onSuccess (haptic).
  const result = await trpcClient.codeReviews.retrigger.mutate({ reviewId: vars.reviewId });
  if (!result.success) {
    throw new Error(result.error);
  }
  return result;
}

export function useRetriggerReview(scope: string) {
  const invalidateReviews = useInvalidateReviews(scope);

  return useMutation({
    mutationFn: retriggerReviewMutationFn,
    onSuccess: (_data, vars) => {
      invalidateReviews(vars.reviewId);
    },
    onError: error => {
      announcingToast.error(error.message);
    },
  });
}

type RouterInputs = inferRouterInputs<MobileRouter>;
type CreateManualReviewInput = RouterInputs['personalReviewAgent']['createManualReviewJob'];

export async function createManualReviewMutationFn(scope: string, vars: CreateManualReviewInput) {
  // Same typed-error pattern: a domain failure throws so the screen's
  // per-call onSuccess (haptic + router.replace to the new review)
  // does not run with `reviewId` undefined. The full success payload
  // (including `reviewId`) still resolves on real success so caller
  // navigation keeps working.
  const result = isPersonal(scope)
    ? await trpcClient.personalReviewAgent.createManualReviewJob.mutate(vars)
    : await trpcClient.organizations.reviewAgent.createManualReviewJob.mutate({
        ...vars,
        organizationId: scope,
      });
  // The create router resolves with the job result directly (no
  // `{success, error}` envelope) or throws. Keep a narrow defensive guard
  // in case the mutation ever returns the `{success: false, error}` shape
  // used by other code-reviews mutations, so a domain failure still routes
  // to onError without treating a real success payload as a failure.
  if ((result as { success?: boolean }).success === false) {
    throw new Error((result as { error?: string }).error ?? i18n.t('codeReviewer.unknownError'));
  }
  return result;
}

export function useCreateManualReview(scope: string) {
  const invalidateReviews = useInvalidateReviews(scope);

  return useMutation({
    mutationFn: createManualReviewMutationFn.bind(null, scope),
    onSuccess: () => {
      invalidateReviews();
    },
    onError: error => {
      announcingToast.error(error.message);
    },
  });
}
