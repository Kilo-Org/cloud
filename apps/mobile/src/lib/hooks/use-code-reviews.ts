import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { hasInFlightReview, isInFlightReviewStatus } from '@kilocode/app-shared/code-review';
import { type inferRouterInputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { PERSONAL_SCOPE } from '@/lib/hooks/use-code-reviewer';
import { trpcClient, useTRPC } from '@/lib/trpc';

function isPersonal(scope: string) {
  return scope === PERSONAL_SCOPE;
}

export const REVIEW_PAGE_SIZE = 50;

type ReviewListPage = Awaited<ReturnType<typeof trpcClient.codeReviews.listForUser.query>>;

/**
 * Build the review-list infinite-query options. Kept as a pure builder so the
 * offset paging is testable without mounting the hook. The query key is exactly
 * the key `useInvalidateReviews` invalidates, so cancel/retrigger/foreground
 * invalidation keeps matching (invalidation is prefix-based).
 *
 * Deliberately not tRPC's `infiniteQueryOptions`: it injects `{ cursor }`, which
 * this offset-based schema does not read.
 */
export function buildReviewListQueryOptions(trpc: ReturnType<typeof useTRPC>, scope: string) {
  const personal = isPersonal(scope);
  return {
    queryKey: personal
      ? trpc.codeReviews.listForUser.queryKey()
      : trpc.codeReviews.listForOrganization.queryKey({ organizationId: scope }),
    initialPageParam: 0,
    queryFn: async ({ pageParam }: { pageParam: number }): Promise<ReviewListPage> => {
      const page = personal
        ? await trpcClient.codeReviews.listForUser.query({
            limit: REVIEW_PAGE_SIZE,
            offset: pageParam,
          })
        : await trpcClient.codeReviews.listForOrganization.query({
            organizationId: scope,
            limit: REVIEW_PAGE_SIZE,
            offset: pageParam,
          });
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
    getNextPageParam: (lastPage: ReviewListPage, _pages: ReviewListPage[], lastPageParam: number) =>
      lastPage.success && lastPage.hasMore ? lastPageParam + lastPage.reviews.length : undefined,
    refetchInterval: (query: { state: { data?: { pages: ReviewListPage[] } } }) => {
      const firstPage = query.state.data?.pages[0];
      if (!firstPage?.success) {
        return false;
      }
      return hasInFlightReview(firstPage.reviews) ? 5000 : false;
    },
  };
}

export function useReviewList(scope: string) {
  const trpc = useTRPC();
  return useInfiniteQuery(buildReviewListQueryOptions(trpc, scope));
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
