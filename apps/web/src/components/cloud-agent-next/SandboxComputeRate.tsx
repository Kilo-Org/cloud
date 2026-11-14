'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { computePriceLabel, formatComputePrice } from '@/lib/cloud-agent/compute-price';
import { usePersonalComputeBillingMode } from '@/hooks/usePersonalComputeBillingMode';
import { sandboxComputeInstance } from './sandbox-status';
import { computeInstanceLabel } from './compute-runs';

export function SandboxComputeRate({
  snapshot,
  organizationId,
}: {
  snapshot: unknown;
  organizationId?: string;
}) {
  const trpc = useTRPC();
  const instance = sandboxComputeInstance(snapshot);
  const rates = useQuery(
    trpc.computeBilling.rates.queryOptions(undefined, { enabled: instance !== null })
  );
  const billingMode = usePersonalComputeBillingMode(organizationId ? null : instance);
  if (instance === null) return null;
  const rate = rates.data?.find(rate => rate.instance === instance);
  return (
    <section className="space-y-2 border-t pt-3 text-xs">
      <h3 className="font-medium">
        {billingMode ? computePriceLabel(billingMode) : 'Compute rate'}
      </h3>
      <dl className="flex items-baseline justify-between gap-4">
        <dt className="text-muted-foreground">{computeInstanceLabel(instance)}</dt>
        <dd className="text-right tabular-nums">
          {rates.isPending ? 'Loading rate…' : formatComputePrice(rate?.hourlyUsd)}
        </dd>
      </dl>
      <p className="text-muted-foreground">
        Compute includes idle time until the sandbox stops. Model usage is separate.
      </p>
    </section>
  );
}
