'use client';

import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import {
  healthErrorSessionsInput,
  type CloudAgentHealthError,
  type CloudAgentHealthInterval,
} from './health-query-input';

export type CloudAgentNextHealthFilters = CloudAgentHealthInterval;
export type CloudAgentFailureResponsibilityFilter = 'all' | 'platform' | 'user' | 'unknown';

function enabledForInterval(params: CloudAgentNextHealthFilters) {
  return Boolean(params.startDate && params.endDate);
}

export function useCloudAgentNextHealthOverview(
  params: CloudAgentNextHealthFilters,
  enabled = true,
  responsibility: CloudAgentFailureResponsibilityFilter = 'all'
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.cloudAgentNext.getHealthOverview.queryOptions({ ...params, responsibility }),
    enabled: enabled && enabledForInterval(params),
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: 60 * 1000,
  });
}

export function useCloudAgentNextHealthErrorSessions(
  params: CloudAgentNextHealthFilters,
  error: CloudAgentHealthError | null
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.admin.cloudAgentNext.listHealthErrorSessions.queryOptions(
      healthErrorSessionsInput(params, error)
    ),
    enabled: enabledForInterval(params) && Boolean(error),
  });
}
