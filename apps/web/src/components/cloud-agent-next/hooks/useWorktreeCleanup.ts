'use client';

import { useEffect, useEffectEvent } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';

export type WorktreeCleanup = NonNullable<
  inferRouterOutputs<RootRouter>['cliSessionsV2']['getWorktreeCleanup']
>;

const reconciledByClient = new WeakMap<QueryClient, Set<string>>();

export function useWorktreeCleanup({
  organizationId,
  onDeleted,
}: {
  organizationId?: string;
  onDeleted: (worktreeId: string, deletedSessionIds: string[]) => Promise<void>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const cleanup = useQuery({
    ...trpc.cliSessionsV2.getWorktreeCleanup.queryOptions({
      organizationId: organizationId ?? null,
    }),
    refetchInterval: query =>
      query.state.data?.items.some(item => item.status === 'pending' || item.status === 'deleting')
        ? 2000
        : 30_000,
  });
  const reconcileDeletion = useEffectEvent(onDeleted);

  useEffect(() => {
    if (!cleanup.data) return;
    let reconciled = reconciledByClient.get(queryClient);
    if (!reconciled) {
      reconciled = new Set<string>();
      reconciledByClient.set(queryClient, reconciled);
    }
    for (const item of cleanup.data.items) {
      const key = JSON.stringify([organizationId ?? null, cleanup.data.id, item.worktreeId]);
      if (item.status !== 'deleted' || reconciled.has(key)) continue;
      reconciled.add(key);
      void reconcileDeletion(item.worktreeId, item.deletedSessionIds).catch(error => {
        reconciled.delete(key);
        console.error('Failed to reconcile deleted workspace:', error);
      });
    }
  }, [cleanup.data, organizationId, queryClient]);

  return cleanup;
}
