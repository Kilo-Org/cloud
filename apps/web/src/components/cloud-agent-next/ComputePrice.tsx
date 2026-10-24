'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { SandboxDestination } from '@kilocode/worker-utils/sandbox-allocation';
import { formatComputePrice } from '@/lib/cloud-agent/compute-price';

export function ComputePrice({
  destination,
  label,
}: {
  destination: SandboxDestination | undefined;
  label?: string;
}) {
  const trpc = useTRPC();
  const native =
    destination?.provider.id === 'cloudflare-containers' && destination.provider.account === 'kilo';
  const rates = useQuery(trpc.computeBilling.rates.queryOptions(undefined, { enabled: native }));
  if (!native) return null;
  const rate = rates.data?.find(rate => rate.instance === destination.instanceType);
  return (
    <span className="text-muted-foreground whitespace-nowrap">
      {label} ·{' '}
      {rates.isLoading
        ? 'Loading price…'
        : rate?.available === false
          ? 'Compute unavailable'
          : formatComputePrice(rate?.hourlyUsd)}
    </span>
  );
}
