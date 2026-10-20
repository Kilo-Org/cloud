'use client';

import { useEffect, useEffectEvent, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';

export type WorktreeCleanup = NonNullable<
  inferRouterOutputs<RootRouter>['cliSessionsV2']['getWorktreeCleanup']
>;

export function useWorktreeCleanup({
  organizationId,
  onDeleted,
}: {
  organizationId?: string;
  onDeleted: (worktreeId: string, deletedSessionIds: string[]) => Promise<void>;
}) {
  const trpc = useTRPC();
  const cleanup = useQuery({
    ...trpc.cliSessionsV2.getWorktreeCleanup.queryOptions({
      organizationId: organizationId ?? null,
    }),
    refetchInterval: query =>
      query.state.data?.items.some(item => item.status === 'pending' || item.status === 'deleting')
        ? 2000
        : 30_000,
  });
  const reconciled = useRef(new Set<string>());
  const reconcileDeletion = useEffectEvent(onDeleted);

  useEffect(() => {
    if (!cleanup.data) return;
    for (const item of cleanup.data.items) {
      const key = `${cleanup.data.id}:${item.worktreeId}`;
      if (item.status !== 'deleted' || reconciled.current.has(key)) continue;
      reconciled.current.add(key);
      void reconcileDeletion(item.worktreeId, item.deletedSessionIds).catch(error => {
        reconciled.current.delete(key);
        console.error('Failed to reconcile deleted workspace:', error);
      });
    }
  }, [cleanup.data]);

  return cleanup;
}
