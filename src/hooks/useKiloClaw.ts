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
      refetchInterval: enabled ? 120_000 : false,
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
      trpc.kiloclaw.listPairingRequests.queryOptions({ refresh: true }, { staleTime: 0 })
    );
    queryClient.setQueryData(trpc.kiloclaw.listPairingRequests.queryKey(), fresh);
  };
}

export function useKiloClawDevicePairing(enabled = true) {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.listDevicePairingRequests.queryOptions(undefined, {
      enabled,
      refetchInterval: enabled ? 120_000 : false,
    })
  );
}

export function useRefreshDevicePairing() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return async () => {
    const fresh = await queryClient.fetchQuery(
      trpc.kiloclaw.listDevicePairingRequests.queryOptions({ refresh: true })
    );
    queryClient.setQueryData(trpc.kiloclaw.listDevicePairingRequests.queryKey(), fresh);
  };
}

export function useKiloClawGatewayStatus(enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.gatewayStatus.queryOptions(undefined, {
      enabled,
      refetchInterval: enabled ? 30_000 : false,
    })
  );
}

export function useGatewayReady(enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.gatewayReady.queryOptions(undefined, {
      enabled,
      refetchInterval: enabled ? 5_000 : false,
    })
  );
}

export function useControllerVersion(enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.controllerVersion.queryOptions(undefined, {
      enabled,
      staleTime: 5 * 60_000, // version changes infrequently; acceptable staleness window
    })
  );
}

export function useKiloClawMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidateStatus = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.kiloclaw.getStatus.queryKey() });
    await queryClient.invalidateQueries({
      queryKey: trpc.kiloclaw.controllerVersion.queryKey(),
    });
  };

  const invalidateStatusAndBilling = async () => {
    await invalidateStatus();
    await queryClient.invalidateQueries({
      queryKey: trpc.kiloclaw.getBillingStatus.queryKey(),
    });
  };

  return {
    start: useMutation(trpc.kiloclaw.start.mutationOptions({ onSuccess: invalidateStatus })),
    stop: useMutation(trpc.kiloclaw.stop.mutationOptions({ onSuccess: invalidateStatus })),
    destroy: useMutation(trpc.kiloclaw.destroy.mutationOptions({ onSuccess: invalidateStatus })),
    provision: useMutation(
      trpc.kiloclaw.provision.mutationOptions({ onSuccess: invalidateStatusAndBilling })
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
    patchSecrets: useMutation(
      trpc.kiloclaw.patchSecrets.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({ queryKey: trpc.kiloclaw.getConfig.queryKey() });
        },
      })
    ),
    restartMachine: useMutation(
      trpc.kiloclaw.restartMachine.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.gatewayStatus.queryKey(),
          });
        },
      })
    ),
    restartOpenClaw: useMutation(
      trpc.kiloclaw.restartOpenClaw.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.gatewayStatus.queryKey(),
          });
        },
      })
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
    approveDevicePairingRequest: useMutation(
      trpc.kiloclaw.approveDevicePairingRequest.mutationOptions({
        onSuccess: async () => {
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.listDevicePairingRequests.queryKey(),
          });
        },
      })
    ),
    runDoctor: useMutation(
      trpc.kiloclaw.runDoctor.mutationOptions({ onSuccess: invalidateStatus })
    ),
    restoreConfig: useMutation(
      trpc.kiloclaw.restoreConfig.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.gatewayStatus.queryKey(),
          });
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.getConfig.queryKey(),
          });
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.readFile.queryKey(),
          });
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.fileTree.queryKey(),
          });
        },
      })
    ),
    setMyPin: useMutation(
      trpc.kiloclaw.setMyPin.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.getMyPin.queryKey(),
          });
        },
      })
    ),
    removeMyPin: useMutation(
      trpc.kiloclaw.removeMyPin.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.getMyPin.queryKey(),
          });
        },
      })
    ),
    writeFile: useMutation(
      trpc.kiloclaw.writeFile.mutationOptions({
        onSuccess: async () => {
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.fileTree.queryKey(),
          });
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.readFile.queryKey(),
          });
        },
      })
    ),
    patchExecPreset: useMutation(
      trpc.kiloclaw.patchExecPreset.mutationOptions({ onSuccess: invalidateStatus })
    ),
    patchOpenclawConfig: useMutation(trpc.kiloclaw.patchOpenclawConfig.mutationOptions()),
    disconnectGoogle: useMutation(
      trpc.kiloclaw.disconnectGoogle.mutationOptions({ onSuccess: invalidateStatus })
    ),
    setGmailNotifications: useMutation(
      trpc.kiloclaw.setGmailNotifications.mutationOptions({ onSuccess: invalidateStatus })
    ),
    rename: useMutation(
      trpc.kiloclaw.renameInstance.mutationOptions({ onSuccess: invalidateStatus })
    ),
  };
}

/** Returns true when KiloClaw is experiencing issues (not "operational"). */
export function useKiloClawServiceDegraded() {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.serviceDegraded.queryOptions(undefined, {
      staleTime: 60_000,
      refetchInterval: 60_000,
    })
  );
}

// User version pinning hooks
export function useKiloClawAvailableVersions(offset = 0, limit = 25) {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.listAvailableVersions.queryOptions(
      { offset, limit },
      {
        staleTime: 5 * 60_000, // versions don't change frequently
      }
    )
  );
}

export function useKiloClawMyPin() {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.getMyPin.queryOptions(undefined, {
      staleTime: 60_000, // pins don't change frequently
    })
  );
}

export function useKiloClawLatestVersion() {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.latestVersion.queryOptions(undefined, {
      staleTime: 60_000, // latest changes infrequently
    })
  );
}

export function useFileTree(enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.fileTree.queryOptions(undefined, {
      enabled,
      refetchOnWindowFocus: false,
    })
  );
}

export function useReadFile(path: string | null, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.readFile.queryOptions(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by `enabled: enabled && path !== null`
      { path: path! },
      {
        enabled: enabled && path !== null,
        refetchOnWindowFocus: false,
        refetchOnMount: 'always',
      }
    )
  );
}
