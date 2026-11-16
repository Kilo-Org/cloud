'use client';

import { useQueries } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

const providers = ['aws', 'aws-ecs'] as const;

/** Keep setup and repair reachable for either AWS engine. */
export function useAwsComputeAccess({
  organizationId,
  enabled,
}: {
  organizationId?: string;
  enabled: boolean;
}): boolean {
  const trpc = useTRPC();
  const enrollments = useQueries({
    queries: providers.map(provider => ({
      ...(organizationId !== undefined
        ? trpc.organizations.awsCompute.getEnrollment.queryOptions({ organizationId, provider })
        : trpc.awsCompute.getEnrollment.queryOptions({ provider })),
      enabled,
    })),
  });
  const statuses = useQueries({
    queries: providers.map(provider => ({
      ...(organizationId !== undefined
        ? trpc.organizations.awsCompute.getStatus.queryOptions({ organizationId, provider })
        : trpc.awsCompute.getStatus.queryOptions({ provider })),
      enabled,
    })),
  });
  return (
    enrollments.some(query => (query.isSuccess && query.data.enrolled) || query.isError) ||
    statuses.some(query => query.data != null || query.isError)
  );
}
