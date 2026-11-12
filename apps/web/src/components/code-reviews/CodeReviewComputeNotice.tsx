'use client';

import { useQuery } from '@tanstack/react-query';
import { Server } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useTRPC } from '@/lib/trpc/utils';
import { formatHourlyRate } from '@/lib/cloud-agent/compute-price';

export function CodeReviewComputeNotice({ organizationId }: { organizationId?: string }) {
  const trpc = useTRPC();
  const rate = useQuery(trpc.computeBilling.codeReviewRate.queryOptions({ organizationId }));

  if (rate.isError) {
    return (
      <Alert>
        <Server aria-hidden="true" />
        <AlertTitle className="line-clamp-none">Cloud Agent pricing is unavailable</AlertTitle>
        <AlertDescription>
          <p>
            Code reviews use Cloud Agents. We could not verify compute billing for this account.
          </p>
          <button type="button" className="underline" onClick={() => void rate.refetch()}>
            Retry
          </button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!rate.data?.enabled) return null;

  return (
    <Alert>
      <Server aria-hidden="true" />
      <AlertTitle className="line-clamp-none">Code reviews use paid Cloud Agents</AlertTitle>
      <AlertDescription>
        <p>Each code review runs in a Cloud Agent container, a paid resource.</p>
        <p>
          Container usage:{' '}
          <span className="font-medium">
            {rate.data.hourlyUsd === null
              ? 'Price unavailable'
              : formatHourlyRate(rate.data.hourlyUsd)}
          </span>
          . Container costs are charged to your Kilo credits, separately from model usage.
        </p>
      </AlertDescription>
    </Alert>
  );
}
