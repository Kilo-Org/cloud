'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

export function useVercelComputeEnrollment({
  organizationId,
  enabled = true,
}: {
  organizationId?: string;
  enabled?: boolean;
}) {
  const trpc = useTRPC();

  return useQuery({
    ...(organizationId !== undefined
      ? trpc.organizations.vercelCompute.getEnrollment.queryOptions({ organizationId })
      : trpc.vercelCompute.getEnrollment.queryOptions()),
    enabled,
  });
}
