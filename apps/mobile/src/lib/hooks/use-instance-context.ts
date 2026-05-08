import { type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useTRPC } from '@/lib/trpc';

export type ClawInstance = inferRouterOutputs<RootRouter>['kiloclaw']['listAllInstances'][number];

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

/**
 * Resolves instance context (org vs personal) by looking up the cached
 * `listAllInstances` data.
 *
 * - `isResolved: false` — data not yet loaded / instance not found.
 *    All downstream queries and mutations should stay disabled.
 * - `isResolved: true, organizationId: null` — personal instance.
 * - `isResolved: true, organizationId: string` — org instance.
 */
export function useInstanceContext(sandboxId: string) {
  const trpc = useTRPC();
  const { data: match } = useQuery({
    ...trpc.kiloclaw.listAllInstances.queryOptions(undefined, {
      staleTime: 30_000,
      refetchInterval: 30_000,
    }),
    select: instances => instances.find(i => i.sandboxId === sandboxId),
  });

  return useMemo(() => {
    if (match === undefined) {
      return { organizationId: undefined, isResolved: false, isOrg: false } as const;
    }
    const organizationId = match.organizationId ?? null;
    return { organizationId, isResolved: true, isOrg: Boolean(organizationId) } as const;
  }, [match]);
}
