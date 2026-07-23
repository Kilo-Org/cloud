import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { hasInFlightReview, isInFlightReviewStatus } from '@kilocode/app-shared/code-review';
import { PERSONAL_SCOPE } from '@/lib/hooks/use-code-reviewer';
import { trpcClient, useTRPC } from '@/lib/trpc';

function isPersonal(scope: string) {
  return scope === PERSONAL_SCOPE;
}

export function useReviewList(scope: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.codeReviews.listForUser.queryOptions({ limit: 50 }),
    enabled: isPersonal(scope),
    refetchInterval: query => {
      const data = query.state.data;
      if (!data?.success) {
        return false;
      }
      return hasInFlightReview(data.reviews) ? 5000 : false;
    },
  });
  const org = useQuery({
    ...trpc.codeReviews.listForOrganization.queryOptions({ organizationId: scope, limit: 50 }),
    enabled: !isPersonal(scope),
    refetchInterval: query => {
      const data = query.state.data;
      if (!data?.success) {
        return false;
      }
      return hasInFlightReview(data.reviews) ? 5000 : false;
    },
  });
  return isPersonal(scope) ? personal : org;
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
      toast.error(error.message);
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
      toast.error(error.message);
    },
  });
}

type CreateManualReviewInput = {
  platform: 'github' | 'gitlab';
  url: string;
  modelSlug: string;
  thinkingEffort?: string | null;
  instructions?: string;
};

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
  // `{success, error}` envelope) or throws — this check is defensive
  // against the `{success: false}` shape other code-reviews mutations
  // use, so a domain failure here still routes to onError.
  if (!(result as { success?: boolean }).success) {
    throw new Error((result as { error?: string }).error);
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
      toast.error(error.message);
    },
  });
}
