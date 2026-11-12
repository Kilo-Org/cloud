'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TRPCClientErrorLike } from '@trpc/client';
import type { GetWorktreeChangesOutput } from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import type { RootRouter } from '@/routers/root-router';
import { getWorktreeChangesQueryKey, preserveNewerWorktreeChanges } from './worktree-changes';

export function useSavedWorktreeChanges({
  userId,
  cloudAgentSessionId,
  organizationId,
  worktreeId,
  enabled,
  refreshToken = 0,
}: {
  userId: string;
  cloudAgentSessionId: string;
  organizationId?: string;
  worktreeId?: string;
  enabled: boolean;
  refreshToken?: number;
}) {
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => getWorktreeChangesQueryKey({ userId, organizationId, worktreeId, cloudAgentSessionId }),
    [userId, organizationId, worktreeId, cloudAgentSessionId]
  );
  const previousRefresh = useRef({ queryKey, refreshToken });
  useEffect(() => {
    const previous = previousRefresh.current;
    previousRefresh.current = { queryKey, refreshToken };
    if (previous.queryKey === queryKey && previous.refreshToken !== refreshToken) {
      void queryClient.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
    }
  }, [queryClient, queryKey, refreshToken]);
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
    staleTime: 5000,
    refetchOnMount: true,
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
