import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import {
  type ClawInstance,
  deriveInstanceContext,
  type InstanceContextResult,
} from './instance-context-logic';
import { useTRPC } from '@/lib/trpc';

export type { ClawInstance, InstanceContextResult };

type ListPollDecider = (instances: ClawInstance[] | undefined) => number;

export function useAllKiloClawInstances(refetchInterval: number | ListPollDecider = 30_000) {
  const trpc = useTRPC();
  const intervalOption =
    typeof refetchInterval === 'function'
      ? (query: { state: { data?: ClawInstance[] } }) => refetchInterval(query.state.data)
      : refetchInterval;
  return useQuery(
    trpc.kiloclaw.listAllInstances.queryOptions(undefined, {
      staleTime: 30_000,
      refetchInterval: intervalOption,
    })
  );
}

/** The instance's org id once `useInstanceContext` resolves to `ready`, otherwise `undefined`. */
export function instanceOrgId(context: InstanceContextResult): string | null | undefined {
  return context.status === 'ready' ? context.organizationId : undefined;
}

export function useInstanceContext(sandboxId: string): InstanceContextResult {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.kiloclaw.listAllInstances.queryOptions(undefined, {
      staleTime: 30_000,
      refetchInterval: 30_000,
    })
  );
  const queryRefetch = query.refetch;
  const refetch = useCallback(() => {
    void queryRefetch();
  }, [queryRefetch]);

  const data = query.data;
  const isError = query.isError;
  return useMemo(
    () => deriveInstanceContext(sandboxId, { data, isError }, refetch),
    [sandboxId, data, isError, refetch]
  );
}
