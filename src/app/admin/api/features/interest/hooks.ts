'use client';

import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

export function useFeatureInterest() {
  const trpc = useTRPC();
  return useQuery(trpc.admin.featureInterest.list.queryOptions());
}

export function useFeatureInterestTimeline(weeks = 12) {
  const trpc = useTRPC();
  return useQuery(trpc.admin.featureInterest.timeline.queryOptions({ weeks }));
}

export function useFeatureInterestDetail(
  slug: string,
  featureName?: string | null,
  limit = 10000,
  offset = 0
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.featureInterest.detail.queryOptions({
      slug,
      name: featureName,
      limit,
      offset,
    }),
    enabled: !!slug,
  });
}
