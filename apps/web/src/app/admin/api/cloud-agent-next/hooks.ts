'use client';

import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

type CloudAgentNextFilters = {
  /** Inclusive ISO datetime lower bound for observed-outcome reporting. */
  startDate: string;
  /** Exclusive ISO datetime upper bound for observed-outcome reporting. */
  endDate: string;
};

export type CloudAgentNextHealthFilters = CloudAgentNextFilters & {
  bucket: 'hour' | 'day';
  createdOnPlatform?: string | null;
};

type CloudAgentNextHealthError = {
  source: 'setup' | 'run';
  stage: string;
  code: string;
};

function enabledForInterval(params: CloudAgentNextFilters) {
  return Boolean(params.startDate && params.endDate);
}

export function useCloudAgentNextHealthPlatforms() {
  const trpc = useTRPC();
  return useQuery(trpc.admin.cloudAgentNext.listHealthPlatforms.queryOptions());
}

export function useCloudAgentNextHealthOverview(
  params: CloudAgentNextHealthFilters,
  enabled = true
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.cloudAgentNext.getHealthOverview.queryOptions(params),
    enabled: enabled && enabledForInterval(params),
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
}

export function useCloudAgentNextHealthErrorSessions(
  params: CloudAgentNextHealthFilters,
  error: CloudAgentNextHealthError | null
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.cloudAgentNext.listHealthErrorSessions.queryOptions({
      startDate: params.startDate,
      endDate: params.endDate,
      source: error?.source ?? 'run',
      stage: error?.stage ?? 'not-selected',
      code: error?.code ?? 'not-selected',
      createdOnPlatform: params.createdOnPlatform,
    }),
    enabled: enabledForInterval(params) && Boolean(error),
  });
}
