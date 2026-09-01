'use client';

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useSavedWorktreeChanges } from './WorktreeChanges';
import { getSavedWorktreeFileState } from './worktree-file';

export function useWorktreeFile({
  cloudAgentSessionId,
  organizationId,
  path,
}: {
  cloudAgentSessionId: string;
  organizationId?: string;
  path: string;
}) {
  const trpc = useTRPC();
  const { saved } = useSavedWorktreeChanges({
    cloudAgentSessionId,
    organizationId,
    enabled: true,
  });
  const snapshot = saved.data?.snapshot;
  const expectedRevision = snapshot?.revision ?? 1;
  const input = { cloudAgentSessionId, path, expectedRevision };
  const queryOptions = organizationId
    ? trpc.organizations.cloudAgentNext.getWorktreeFile.queryOptions({ ...input, organizationId })
    : trpc.cloudAgentNext.getWorktreeFile.queryOptions(input);
  const file = useQuery({
    ...queryOptions,
    enabled: !saved.isError && snapshot?.files.some(file => file.path === path) === true,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });
  const state = getSavedWorktreeFileState({
    snapshot,
    path,
    result: file.data,
    summaryError: saved.isError,
    fileError: file.isError,
  });
  const scope = JSON.stringify([organizationId ?? null, cloudAgentSessionId, path]);
  const requestKey = JSON.stringify([scope, expectedRevision]);
  const activeRequest = useRef<string | null>(null);
  const retriedScope = useRef<string | null>(null);

  useEffect(() => {
    activeRequest.current = requestKey;
    if (state.status === 'available' || state.status === 'omitted') {
      retriedScope.current = null;
    } else if (state.status === 'stale' && retriedScope.current !== scope) {
      retriedScope.current = scope;
      void saved.refetch().then(result => {
        if (
          activeRequest.current === requestKey &&
          !result.isError &&
          result.data?.snapshot?.revision === expectedRevision
        ) {
          void file.refetch();
        }
      });
    }
    return () => {
      activeRequest.current = null;
    };
  }, [state.status, scope, requestKey, expectedRevision, saved.refetch, file.refetch]);

  async function reload() {
    retriedScope.current = scope;
    const result = await saved.refetch();
    if (
      activeRequest.current === requestKey &&
      !result.isError &&
      result.data?.snapshot?.revision === expectedRevision &&
      result.data.snapshot.files.some(file => file.path === path)
    ) {
      await file.refetch();
    }
  }

  return { state, isFetching: saved.isFetching || file.isFetching, reload };
}
