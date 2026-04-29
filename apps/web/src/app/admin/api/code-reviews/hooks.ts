'use client';

import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

export type FilterParams = {
  startDate: string;
  endDate: string;
  userId?: string;
  organizationId?: string;
  ownershipType?: 'all' | 'personal' | 'organization';
  agentVersion?: 'all' | 'v1' | 'v2';
};

export function useCodeReviewOverviewStats(params: FilterParams) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.codeReviews.getOverviewStats.queryOptions(params),
    enabled: Boolean(params.startDate && params.endDate),
  });
}

export function useCodeReviewDailyStats(params: FilterParams) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.codeReviews.getDailyStats.queryOptions(params),
    enabled: Boolean(params.startDate && params.endDate),
  });
}

export function useCodeReviewPerformanceStats(params: FilterParams) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.codeReviews.getPerformanceStats.queryOptions(params),
    enabled: Boolean(params.startDate && params.endDate),
  });
}

export function useCodeReviewWaitTimeStats(params: FilterParams) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.codeReviews.getWaitTimeStats.queryOptions(params),
    enabled: Boolean(params.startDate && params.endDate),
  });
}

export function useCodeReviewCancellationAnalysis(params: FilterParams) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.codeReviews.getCancellationAnalysis.queryOptions(params),
    enabled: Boolean(params.startDate && params.endDate),
  });
}

export function useCodeReviewErrorAnalysis(params: FilterParams) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.codeReviews.getErrorAnalysis.queryOptions(params),
    enabled: Boolean(params.startDate && params.endDate),
  });
}

export function useCodeReviewUserSegmentation(params: FilterParams) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.codeReviews.getUserSegmentation.queryOptions(params),
    enabled: Boolean(params.startDate && params.endDate),
  });
}

export function useCodeReviewErrorSessions(params: FilterParams & { errorMessage: string | null }) {
  const trpc = useTRPC();
  const { errorMessage, ...filterParams } = params;
  return useQuery({
    ...trpc.admin.codeReviews.getErrorSessions.queryOptions({
      ...filterParams,
      errorMessage: errorMessage ?? '',
    }),
    enabled: Boolean(params.startDate && params.endDate && errorMessage),
  });
}

export function useSearchUsers(query: string, enabled: boolean = true) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.codeReviews.searchUsers.queryOptions({ query }),
    enabled: enabled && query.length >= 1,
  });
}

export function useSearchOrganizations(query: string, enabled: boolean = true) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.codeReviews.searchOrganizations.queryOptions({ query }),
    enabled: enabled && query.length >= 1,
  });
}
