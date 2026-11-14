'use client';

import { skipToken, useQuery } from '@tanstack/react-query';
import type { CloudflareContainersInstance } from '@kilocode/worker-utils/sandbox-allocation';
import { useTRPC } from '@/lib/trpc/utils';
import type { ComputeBillingMode } from '@/lib/cloud-agent/compute-price';

/** Undefined while loading, after a failed check, or with no instance; callers then show no billing state. */
export function usePersonalComputeBillingMode(
  instance: CloudflareContainersInstance | null
): ComputeBillingMode | undefined {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.computeBilling.personalBillingMode.queryOptions(instance ? { instance } : skipToken),
    retry: false,
  });
  return query.data?.billingMode;
}
