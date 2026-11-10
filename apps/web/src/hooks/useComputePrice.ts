'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type {
  SandboxAllocationRequest,
  SandboxDestination,
} from '@kilocode/worker-utils/sandbox-allocation';
import { formatComputePrice } from '@/lib/cloud-agent/compute-price';

/** Prices Kilo-hosted containers. Other providers bill compute themselves, so they get no price. */
export function useComputePrice(): (
  destination: SandboxAllocationRequest | SandboxDestination | undefined
) => string | undefined {
  const trpc = useTRPC();
  const rates = useQuery(trpc.computeBilling.rates.queryOptions());
  return destination => {
    if (
      destination?.provider.id !== 'cloudflare-containers' ||
      destination.provider.account !== 'kilo' ||
      !rates.data
    )
      return undefined;
    const rate = rates.data.find(rate => rate.instance === destination.instanceType);
    if (rate?.available === false) return 'Unavailable';
    return formatComputePrice(rate?.hourlyUsd);
  };
}
