'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

export const useOrganizationMetrics = () => {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.organizations.admin.getMetrics.queryOptions(),
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};
