'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { formatComputePrice } from '@/lib/cloud-agent/compute-price';

export function SessionComputeRate() {
  const trpc = useTRPC();
  const rates = useQuery(trpc.computeBilling.rates.queryOptions());
  return (
    <section className="space-y-2 rounded-lg border p-4 text-sm">
      <h3 className="font-medium">Kilo compute rates</h3>
      <dl className="grid grid-cols-2 gap-2 tabular-nums">
        {(['standard-3', 'standard-4'] as const).map(instance => (
          <div key={instance} className="contents">
            <dt>{instance === 'standard-3' ? 'Medium' : 'Large'}</dt>
            <dd className="text-right">
              {formatComputePrice(rates.data?.find(rate => rate.instance === instance)?.hourlyUsd)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground text-xs">
        For Kilo Cloudflare Containers. Your own provider bills BYOC compute.
      </p>
      <p className="text-muted-foreground text-xs">
        Compute includes idle time until the sandbox stops. Model usage is separate.
      </p>
    </section>
  );
}
