'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { preserveNewerWorktreeChanges } from './worktree-changes';

export function useSavedWorktreeChanges({
  cloudAgentSessionId,
  organizationId,
  enabled,
}: {
  cloudAgentSessionId: string;
  organizationId?: string;
  enabled: boolean;
}) {
  const trpc = useTRPC();
  const queryOptions = useMemo(
    () =>
      organizationId
        ? trpc.organizations.cloudAgentNext.getWorktreeChanges.queryOptions(
            { organizationId, cloudAgentSessionId },
            { trpc: { abortOnUnmount: true, context: { skipBatch: true } } }
          )
        : trpc.cloudAgentNext.getWorktreeChanges.queryOptions(
            { cloudAgentSessionId },
            { trpc: { abortOnUnmount: true, context: { skipBatch: true } } }
          ),
    [trpc, organizationId, cloudAgentSessionId]
  );
  const saved = useQuery({
    ...queryOptions,
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: (failureCount, error) => {
      const status = error.data?.httpStatus;
      return (
        failureCount < 2 &&
        (status === undefined || status === 408 || status === 429 || status >= 500)
      );
    },
    structuralSharing: preserveNewerWorktreeChanges,
  });
  return { saved, queryKey: queryOptions.queryKey };
}
