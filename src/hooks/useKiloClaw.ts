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

export function useKiloClawPairing(enabled = true) {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.listPairingRequests.queryOptions(undefined, {
      enabled,
      refetchInterval: enabled ? 60_000 : false,
    })
  );
}

export function useRefreshPairing() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return async () => {
    // Fetch with refresh=true to bust KV cache, then write the result
    // into the normal (no-input) query so the component sees it immediately.
    const fresh = await queryClient.fetchQuery(
      trpc.kiloclaw.listPairingRequests.queryOptions({ refresh: true })
    );
    queryClient.setQueryData(trpc.kiloclaw.listPairingRequests.queryKey(), fresh);
  };
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
    provision: useMutation(
      trpc.kiloclaw.provision.mutationOptions({ onSuccess: invalidateStatus })
    ),
    patchConfig: useMutation(
      trpc.kiloclaw.patchConfig.mutationOptions({ onSuccess: invalidateStatus })
    ),
    updateConfig: useMutation(
      trpc.kiloclaw.updateConfig.mutationOptions({ onSuccess: invalidateStatus })
    ),
    updateKiloCodeConfig: useMutation(
      trpc.kiloclaw.updateKiloCodeConfig.mutationOptions({ onSuccess: invalidateStatus })
    ),
    patchChannels: useMutation(
      trpc.kiloclaw.patchChannels.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({ queryKey: trpc.kiloclaw.getConfig.queryKey() });
        },
      })
    ),
    restartGateway: useMutation(
      trpc.kiloclaw.restartGateway.mutationOptions({ onSuccess: invalidateStatus })
    ),
    approvePairingRequest: useMutation(
      trpc.kiloclaw.approvePairingRequest.mutationOptions({
        onSuccess: async () => {
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.listPairingRequests.queryKey(),
          });
        },
      })
    ),
  };
}
