'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TRPCClientErrorLike } from '@trpc/client';
import type { GetWorktreeChangesOutput } from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import type { RootRouter } from '@/routers/root-router';
import { getWorktreeChangesQueryKey, preserveNewerWorktreeChanges } from './worktree-changes';

export function useSavedWorktreeChanges({
  cloudAgentSessionId,
  organizationId,
  worktreeId,
  enabled,
}: {
  cloudAgentSessionId: string;
  organizationId?: string;
  worktreeId?: string;
  enabled: boolean;
}) {
  const trpcClient = useRawTRPCClient();
  const queryKey = useMemo(
    () => getWorktreeChangesQueryKey({ organizationId, worktreeId, cloudAgentSessionId }),
    [organizationId, worktreeId, cloudAgentSessionId]
  );
  const saved = useQuery<GetWorktreeChangesOutput, TRPCClientErrorLike<RootRouter>>({
    queryKey,
    queryFn: ({ signal }) =>
      organizationId
        ? trpcClient.organizations.cloudAgentNext.getWorktreeChanges.query(
            { organizationId, cloudAgentSessionId },
            { signal, context: { skipBatch: true } }
          )
        : trpcClient.cloudAgentNext.getWorktreeChanges.query(
            { cloudAgentSessionId },
            { signal, context: { skipBatch: true } }
          ),
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
  return { saved, queryKey };
}
