'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

/** Keep setup and repair reachable for enrolled owners and owners with a saved connection. */
export function useAwsComputeAccess({
  organizationId,
  enabled,
}: {
  organizationId?: string;
  enabled: boolean;
}): boolean {
  const trpc = useTRPC();
  const enrollment = useQuery({
    ...(organizationId !== undefined
      ? trpc.organizations.awsCompute.getEnrollment.queryOptions({ organizationId })
      : trpc.awsCompute.getEnrollment.queryOptions()),
    enabled,
  });
  const status = useQuery({
    ...(organizationId !== undefined
      ? trpc.organizations.awsCompute.getStatus.queryOptions({ organizationId })
      : trpc.awsCompute.getStatus.queryOptions()),
    enabled,
  });
  return (
    (enrollment.isSuccess && enrollment.data.enrolled) ||
    enrollment.isError ||
    status.data != null ||
    status.isError
  );
}
