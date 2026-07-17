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

export function useCancelReview(scope: string) {
  const invalidateReviews = useInvalidateReviews(scope);

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: { reviewId: string }) =>
      trpcClient.codeReviews.cancel.mutate({ reviewId: vars.reviewId }),
    onSuccess: (data, vars) => {
      if (!data.success) {
        toast.error(data.error);
        return;
      }
      invalidateReviews(vars.reviewId);
    },
    onError: error => {
      toast.error(error.message);
    },
  });
}

export function useRetriggerReview(scope: string) {
  const invalidateReviews = useInvalidateReviews(scope);

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: { reviewId: string }) =>
      trpcClient.codeReviews.retrigger.mutate({ reviewId: vars.reviewId }),
    onSuccess: (data, vars) => {
      if (!data.success) {
        toast.error(data.error);
        return;
      }
      invalidateReviews(vars.reviewId);
    },
    onError: error => {
      toast.error(error.message);
    },
  });
}

export function useCreateManualReview(scope: string) {
  const invalidateReviews = useInvalidateReviews(scope);

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: {
      platform: 'github' | 'gitlab';
      url: string;
      modelSlug: string;
      thinkingEffort?: string | null;
      instructions?: string;
    }) =>
      isPersonal(scope)
        ? trpcClient.personalReviewAgent.createManualReviewJob.mutate(vars)
        : trpcClient.organizations.reviewAgent.createManualReviewJob.mutate({
            ...vars,
            organizationId: scope,
          }),
    onSuccess: () => {
      invalidateReviews();
    },
    onError: error => {
      toast.error(error.message);
    },
  });
}
