'use client';

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useSavedWorktreeChanges } from './useSavedWorktreeChanges';
import { getSavedWorktreeFileState, selectSavedWorktreeFile } from './worktree-file';
import type { WorktreeFileQuery } from '@kilocode/worker-utils/cloud-agent-worktree-changes';

export function useWorktreeFile({
  cloudAgentSessionId,
  organizationId,
  path,
  scope,
}: {
  cloudAgentSessionId: string;
  organizationId?: string;
  path: string;
  scope?: WorktreeFileQuery['scope'];
}) {
  const trpc = useTRPC();
  const { saved } = useSavedWorktreeChanges({
    cloudAgentSessionId,
    organizationId,
    enabled: true,
  });
  const snapshot = saved.data?.snapshot;
  const selectedEntry = selectSavedWorktreeFile(snapshot, path, scope);
  const expectedRevision = selectedEntry?.revision ?? 1;
  const selectedScope = selectedEntry?.scope ?? scope;
  const input = { cloudAgentSessionId, path, scope: selectedScope, expectedRevision };
  const queryOptions = organizationId
    ? trpc.organizations.cloudAgentNext.getWorktreeFile.queryOptions({ ...input, organizationId })
    : trpc.cloudAgentNext.getWorktreeFile.queryOptions(input);
  const file = useQuery({
    ...queryOptions,
    enabled: !saved.isError && selectedEntry !== undefined,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });
  const state = getSavedWorktreeFileState({
    snapshot,
    path,
    scope,
    selectedEntry,
    result: file.data,
    summaryError: saved.isError,
    fileError: file.isError,
  });
  const identity = JSON.stringify([
    organizationId ?? null,
    cloudAgentSessionId,
    path,
    scope ?? null,
    selectedScope ?? null,
  ]);
  const requestKey = JSON.stringify([identity, expectedRevision]);
  const activeRequest = useRef<string | null>(null);
  const retriedIdentity = useRef<string | null>(null);

  useEffect(() => {
    activeRequest.current = requestKey;
    if (state.status === 'available' || state.status === 'omitted') {
      retriedIdentity.current = null;
    } else if (state.status === 'stale' && retriedIdentity.current !== identity) {
      retriedIdentity.current = identity;
      void saved.refetch().then(result => {
        const nextEntry = selectSavedWorktreeFile(result.data?.snapshot, path, scope);
        if (
          activeRequest.current === requestKey &&
          !result.isError &&
          nextEntry?.scope === selectedScope &&
          nextEntry?.revision === expectedRevision
        ) {
          void file.refetch();
        }
      });
    }
    return () => {
      activeRequest.current = null;
    };
  }, [
    state.status,
    identity,
    requestKey,
    path,
    scope,
    selectedScope,
    expectedRevision,
    saved.refetch,
    file.refetch,
  ]);

  async function reload() {
    retriedIdentity.current = identity;
    const result = await saved.refetch();
    const nextEntry = selectSavedWorktreeFile(result.data?.snapshot, path, scope);
    if (
      activeRequest.current === requestKey &&
      !result.isError &&
      nextEntry?.scope === selectedScope &&
      nextEntry?.revision === expectedRevision
    ) {
      await file.refetch();
    }
  }

  return { state, isFetching: saved.isFetching || file.isFetching, reload };
}
