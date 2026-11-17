'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type {
  SandboxAllocationRequest,
  SandboxDestination,
} from '@kilocode/worker-utils/sandbox-allocation';
import { formatComputePrice, kiloContainersInstance } from '@/lib/cloud-agent/compute-price';

/** Prices Kilo-hosted containers. Other providers bill compute themselves, so they get no price. */
export function useComputePrice(): (
  destination: SandboxAllocationRequest | SandboxDestination | undefined
) => string | undefined {
  const trpc = useTRPC();
  const rates = useQuery(trpc.computeBilling.rates.queryOptions());
  return destination => {
    const instance = kiloContainersInstance(destination);
    if (!instance || !rates.data) return undefined;
    const rate = rates.data.find(rate => rate.instance === instance);
    if (rate?.available === false) return 'Price unavailable';
    return formatComputePrice(rate?.hourlyUsd);
  };
}
