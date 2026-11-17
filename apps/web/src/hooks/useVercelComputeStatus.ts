'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

export function useVercelComputeStatus({
  organizationId,
  enabled = true,
}: {
  organizationId?: string;
  enabled?: boolean;
}) {
  const trpc = useTRPC();

  return useQuery({
    ...(organizationId !== undefined
      ? trpc.organizations.vercelCompute.getStatus.queryOptions({ organizationId })
      : trpc.vercelCompute.getStatus.queryOptions()),
    enabled,
    refetchInterval: query =>
      query.state.data?.setupStatus === 'pending' ||
      query.state.data?.setupStatus === 'building' ||
      query.state.data?.upgradeStatus === 'pending' ||
      query.state.data?.upgradeStatus === 'building'
        ? 2_000
        : false,
  });
}
