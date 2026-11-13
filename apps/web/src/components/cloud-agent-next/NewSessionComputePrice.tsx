'use client';

import { Box } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { computePriceNote } from '@/lib/cloud-agent/compute-price';
import { usePersonalComputeBillingMode } from '@/hooks/usePersonalComputeBillingMode';
import type { EnvironmentRepository, EnvironmentSummary } from '@/hooks/useCloudAgentEnvironments';
import { repositoryName } from './environment-repositories';
import { formatSandboxCapacity } from './sandbox-selection';
import { kiloContainersInstance, newSessionSandboxDestination } from './new-session-sandbox';

/** The compute price of a personal session's sandbox. Hidden until the price and billing mode are known. */
export function NewSessionComputePrice({
  repository,
  environment,
}: {
  repository: EnvironmentRepository | undefined;
  environment: EnvironmentSummary | null | undefined;
}) {
  const trpc = useTRPC();
  const selection = useQuery({
    ...trpc.cloudAgentNext.getSandboxSelectionOptions.queryOptions(
      repository
        ? { repositoryType: repository.platform, repositoryFullName: repositoryName(repository) }
        : {}
    ),
    retry: false,
  });
  const destination = newSessionSandboxDestination(environment?.sandboxAllocation, selection.data);
  const instance = kiloContainersInstance(destination);
  const rates = useQuery(
    trpc.computeBilling.rates.queryOptions(undefined, { enabled: instance !== null })
  );
  const billingMode = usePersonalComputeBillingMode(instance);
  const note = computePriceNote(
    billingMode,
    rates.data?.find(rate => rate.instance === instance)
  );
  if (!note || !destination) return null;

  return (
    <p className="text-muted-foreground mt-0.5 flex items-center gap-1.5 pl-[calc(0.5rem+1px)] text-xs tabular-nums">
      <Box className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        {note.label}: {note.price} · {formatSandboxCapacity(destination)}
      </span>
    </p>
  );
}
