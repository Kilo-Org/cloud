'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

export function useKiloClawStatus() {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.getStatus.queryOptions(undefined, {
      refetchInterval: 10_000,
    })
  );
}

export function useKiloClawConfig() {
  const trpc = useTRPC();
  return useQuery(trpc.kiloclaw.getConfig.queryOptions());
}

export function useKiloClawStorageInfo() {
  const trpc = useTRPC();
  return useQuery(trpc.kiloclaw.getStorageInfo.queryOptions());
}

export function useKiloClawMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidateStatus = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.kiloclaw.getStatus.queryKey() });
  };

  return {
    start: useMutation(trpc.kiloclaw.start.mutationOptions({ onSuccess: invalidateStatus })),
    stop: useMutation(trpc.kiloclaw.stop.mutationOptions({ onSuccess: invalidateStatus })),
    destroy: useMutation(trpc.kiloclaw.destroy.mutationOptions({ onSuccess: invalidateStatus })),
    updateConfig: useMutation(
      trpc.kiloclaw.updateConfig.mutationOptions({ onSuccess: invalidateStatus })
    ),
    restartGateway: useMutation(
      trpc.kiloclaw.restartGateway.mutationOptions({ onSuccess: invalidateStatus })
    ),
    syncStorage: useMutation(
      trpc.kiloclaw.syncStorage.mutationOptions({ onSuccess: invalidateStatus })
    ),
  };
}
