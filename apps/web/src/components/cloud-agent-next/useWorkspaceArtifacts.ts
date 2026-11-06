'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import type { TRPCClientErrorLike } from '@trpc/client';
import type { ListWorkspaceArtifactsOutput } from '@kilocode/worker-utils/cloud-agent-workspace-artifacts';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import type { RootRouter } from '@/routers/root-router';
import { useManager } from './CloudAgentProvider';
import { getWorkspaceArtifactsQueryKey } from './workspace-artifacts';

export function useWorkspaceArtifacts({
  userId,
  cloudAgentSessionId,
  organizationId,
  enabled,
  sandboxStatusEnabled = true,
}: {
  userId: string;
  cloudAgentSessionId: string;
  organizationId?: string;
  enabled: boolean;
  sandboxStatusEnabled?: boolean;
}) {
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const manager = useManager();
  const refreshSignal = useAtomValue(manager.atoms.workspaceArtifactsRefresh);
  const queryKey = useMemo(
    () => getWorkspaceArtifactsQueryKey({ userId, organizationId, cloudAgentSessionId }),
    [userId, organizationId, cloudAgentSessionId]
  );

  const list = useQuery<ListWorkspaceArtifactsOutput, TRPCClientErrorLike<RootRouter>>({
    queryKey,
    queryFn: ({ signal }) =>
      organizationId
        ? trpcClient.organizations.cloudAgentNext.listWorkspaceArtifacts.query(
            { organizationId, cloudAgentSessionId },
            { signal, context: { skipBatch: true } }
          )
        : trpcClient.cloudAgentNext.listWorkspaceArtifacts.query(
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
  });

  const sandboxStatus = useQuery({
    queryKey: ['workspace-artifacts-sandbox-status', organizationId ?? null, cloudAgentSessionId],
    queryFn: ({ signal }) =>
      organizationId
        ? trpcClient.organizations.cloudAgentNext.getSandboxStatus.query(
            { organizationId, cloudAgentSessionId },
            { signal, context: { skipBatch: true } }
          )
        : trpcClient.cloudAgentNext.getSandboxStatus.query(
            { cloudAgentSessionId },
            { signal, context: { skipBatch: true } }
          ),
    enabled: enabled && sandboxStatusEnabled,
    staleTime: 30_000,
    refetchInterval: enabled && sandboxStatusEnabled ? 30_000 : false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: false,
  });

  const handledSignal = useRef(refreshSignal);
  useEffect(() => {
    const previous = handledSignal.current;
    if (previous === refreshSignal) return;
    handledSignal.current = refreshSignal;
    if (refreshSignal?.cloudSessionId !== cloudAgentSessionId) return;
    const reconnected =
      previous?.cloudSessionId !== refreshSignal.cloudSessionId ||
      previous?.connectionVersion !== refreshSignal.connectionVersion;
    const cached = queryClient.getQueryData<ListWorkspaceArtifactsOutput>(queryKey);
    if (
      !reconnected &&
      refreshSignal.revision !== undefined &&
      (cached?.revision ?? 0) >= refreshSignal.revision
    ) {
      return;
    }
    void queryClient.invalidateQueries({ queryKey });
  }, [refreshSignal, cloudAgentSessionId, queryClient, queryKey]);

  return { list, sandboxStatus, queryKey };
}
