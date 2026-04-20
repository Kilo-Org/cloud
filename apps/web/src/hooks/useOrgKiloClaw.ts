'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export function useOrgKiloClawStatus(organizationId?: string) {
  const trpc = useTRPC();
  const resolvedOrganizationId = organizationId ?? NIL_UUID;
  return useQuery(
    trpc.organizations.kiloclaw.getStatus.queryOptions(
      { organizationId: resolvedOrganizationId },
      { enabled: !!organizationId, refetchInterval: organizationId ? 10_000 : false }
    )
  );
}

export function useOrgKiloClawConfig(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.organizations.kiloclaw.getConfig.queryOptions({ organizationId }));
}

export function useOrgKiloClawPairing(organizationId: string, enabled = true) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.kiloclaw.listPairingRequests.queryOptions(
      { organizationId },
      { enabled, refetchInterval: enabled ? 120_000 : false }
    )
  );
}

export function useOrgRefreshPairing(organizationId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return async () => {
    const fresh = await queryClient.fetchQuery(
      trpc.organizations.kiloclaw.listPairingRequests.queryOptions(
        { organizationId, refresh: true },
        { staleTime: 0 }
      )
    );
    queryClient.setQueryData(
      trpc.organizations.kiloclaw.listPairingRequests.queryKey({ organizationId }),
      fresh
    );
  };
}

export function useOrgKiloClawDevicePairing(organizationId: string, enabled = true) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.kiloclaw.listDevicePairingRequests.queryOptions(
      { organizationId },
      { enabled, refetchInterval: enabled ? 120_000 : false }
    )
  );
}

export function useOrgRefreshDevicePairing(organizationId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return async () => {
    const fresh = await queryClient.fetchQuery(
      trpc.organizations.kiloclaw.listDevicePairingRequests.queryOptions({
        organizationId,
        refresh: true,
      })
    );
    queryClient.setQueryData(
      trpc.organizations.kiloclaw.listDevicePairingRequests.queryKey({ organizationId }),
      fresh
    );
  };
}

export function useOrgKiloClawGatewayStatus(organizationId: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.kiloclaw.gatewayStatus.queryOptions(
      { organizationId },
      { enabled, refetchInterval: enabled ? 30_000 : false }
    )
  );
}

export function useOrgGatewayReady(organizationId: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.kiloclaw.gatewayReady.queryOptions(
      { organizationId },
      { enabled, refetchInterval: enabled ? 5_000 : false }
    )
  );
}

export function useOrgControllerVersion(organizationId: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.kiloclaw.controllerVersion.queryOptions(
      { organizationId },
      { enabled, staleTime: 5 * 60_000 }
    )
  );
}

export function useOrgKiloClawServiceDegraded(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.kiloclaw.serviceDegraded.queryOptions(
      { organizationId },
      { staleTime: 60_000, refetchInterval: 60_000 }
    )
  );
}

export function useOrgKiloClawLatestVersion(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.kiloclaw.latestVersion.queryOptions(
      { organizationId },
      { staleTime: 60_000 }
    )
  );
}

export function useOrgKiloClawAvailableVersions(organizationId: string, offset = 0, limit = 25) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.kiloclaw.listAvailableVersions.queryOptions(
      { organizationId, offset, limit },
      { staleTime: 5 * 60_000 }
    )
  );
}

export function useOrgKiloClawMyPin(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.kiloclaw.getMyPin.queryOptions({ organizationId }, { staleTime: 60_000 })
  );
}

export function useOrgFileTree(organizationId: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.kiloclaw.fileTree.queryOptions(
      { organizationId },
      { enabled, refetchOnWindowFocus: false }
    )
  );
}

export function useOrgReadFile(organizationId: string, path: string | null, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.kiloclaw.readFile.queryOptions(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by `enabled: enabled && path !== null`
      { organizationId, path: path! },
      {
        enabled: enabled && path !== null,
        refetchOnWindowFocus: false,
        refetchOnMount: 'always',
      }
    )
  );
}

/**
 * Org mutations hook that returns the same type as `useKiloClawMutations`.
 *
 * Each raw org mutation requires `{ organizationId, ...rest }` as input.
 * This hook wraps `mutate`/`mutateAsync` on every mutation to pre-bind
 * `organizationId`, so callers see the same `.mutate()` / `.mutate({ imageTag })`
 * interface as personal mutations. All other properties (isPending, data, etc.)
 * pass through from the raw mutation.
 */
export function useOrgKiloClawMutations(organizationId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const invalidateStatus = async () => {
    await queryClient.invalidateQueries({
      queryKey: trpc.organizations.kiloclaw.getStatus.queryKey({ organizationId }),
    });
    await queryClient.invalidateQueries({
      queryKey: trpc.organizations.kiloclaw.controllerVersion.queryKey({ organizationId }),
    });
  };

  const resetAllInstanceState = async () => {
    await invalidateStatus();
    queryClient.removeQueries({
      queryKey: trpc.organizations.kiloclaw.gatewayReady.queryKey({ organizationId }),
    });
    queryClient.removeQueries({
      queryKey: trpc.organizations.kiloclaw.gatewayStatus.queryKey({ organizationId }),
    });
    queryClient.removeQueries({
      queryKey: trpc.organizations.kiloclaw.getConfig.queryKey({ organizationId }),
    });
  };

  // Helper: wrap a raw org mutation so mutate/mutateAsync inject organizationId.
  // The `any` types are unavoidable here — we're wrapping tRPC mutations generically
  // to pre-bind organizationId. The final return is cast to the personal mutations type.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function bind<T extends { mutate: any; mutateAsync: any }>(raw: T): any {
    return {
      ...raw,
      mutate: (input: any, opts: any) => raw.mutate({ organizationId, ...input }, opts),
      mutateAsync: (input: any, opts: any) => raw.mutateAsync({ organizationId, ...input }, opts),
    };
  }

  function bindVoid<T extends { mutate: any; mutateAsync: any }>(raw: T): any {
    return {
      ...raw,
      mutate: (_input: any, opts: any) => raw.mutate({ organizationId }, opts),
      mutateAsync: (_input: any, opts: any) => raw.mutateAsync({ organizationId }, opts),
    };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const rawStart = useMutation(
    trpc.organizations.kiloclaw.start.mutationOptions({ onSuccess: invalidateStatus })
  );
  const rawStop = useMutation(
    trpc.organizations.kiloclaw.stop.mutationOptions({ onSuccess: invalidateStatus })
  );
  const rawDestroy = useMutation(
    trpc.organizations.kiloclaw.destroy.mutationOptions({ onSuccess: resetAllInstanceState })
  );
  const rawProvision = useMutation(
    trpc.organizations.kiloclaw.provision.mutationOptions({ onSuccess: invalidateStatus })
  );
  const rawCycleInboundEmailAddress = useMutation(
    trpc.organizations.kiloclaw.cycleInboundEmailAddress.mutationOptions({
      onSuccess: invalidateStatus,
    })
  );
  const rawPatchConfig = useMutation(
    trpc.organizations.kiloclaw.patchConfig.mutationOptions({ onSuccess: invalidateStatus })
  );
  const rawUpdateConfig = useMutation(
    trpc.organizations.kiloclaw.updateConfig.mutationOptions({ onSuccess: invalidateStatus })
  );
  const rawUpdateKiloCodeConfig = useMutation(
    trpc.organizations.kiloclaw.updateKiloCodeConfig.mutationOptions({
      onSuccess: invalidateStatus,
    })
  );
  const rawPatchChannels = useMutation(
    trpc.organizations.kiloclaw.patchChannels.mutationOptions({
      onSuccess: async () => {
        await invalidateStatus();
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.getConfig.queryKey({ organizationId }),
        });
      },
    })
  );
  const rawPatchSecrets = useMutation(
    trpc.organizations.kiloclaw.patchSecrets.mutationOptions({
      onSuccess: async () => {
        await invalidateStatus();
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.getConfig.queryKey({ organizationId }),
        });
      },
    })
  );
  const rawRestartMachine = useMutation(
    trpc.organizations.kiloclaw.restartMachine.mutationOptions({
      onSuccess: async () => {
        await invalidateStatus();
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.gatewayStatus.queryKey({ organizationId }),
        });
      },
    })
  );
  const rawRestartOpenClaw = useMutation(
    trpc.organizations.kiloclaw.restartOpenClaw.mutationOptions({
      onSuccess: async () => {
        await invalidateStatus();
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.gatewayStatus.queryKey({ organizationId }),
        });
      },
    })
  );
  const rawApprovePairing = useMutation(
    trpc.organizations.kiloclaw.approvePairingRequest.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.listPairingRequests.queryKey({ organizationId }),
        });
      },
    })
  );
  const rawApproveDevicePairing = useMutation(
    trpc.organizations.kiloclaw.approveDevicePairingRequest.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.listDevicePairingRequests.queryKey({
            organizationId,
          }),
        });
      },
    })
  );
  const rawRunDoctor = useMutation(
    trpc.organizations.kiloclaw.runDoctor.mutationOptions({ onSuccess: invalidateStatus })
  );
  const rawRestoreConfig = useMutation(
    trpc.organizations.kiloclaw.restoreConfig.mutationOptions({
      onSuccess: async () => {
        await invalidateStatus();
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.gatewayStatus.queryKey({ organizationId }),
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.getConfig.queryKey({ organizationId }),
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.readFile.queryKey(),
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.fileTree.queryKey(),
        });
      },
    })
  );
  const rawSetMyPin = useMutation(
    trpc.organizations.kiloclaw.setMyPin.mutationOptions({
      onSuccess: async () => {
        await invalidateStatus();
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.getMyPin.queryKey({ organizationId }),
        });
      },
    })
  );
  const rawRemoveMyPin = useMutation(
    trpc.organizations.kiloclaw.removeMyPin.mutationOptions({
      onSuccess: async () => {
        await invalidateStatus();
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.getMyPin.queryKey({ organizationId }),
        });
      },
    })
  );
  const rawWriteFile = useMutation(
    trpc.organizations.kiloclaw.writeFile.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.fileTree.queryKey(),
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.readFile.queryKey(),
        });
      },
    })
  );
  const rawPatchExecPreset = useMutation(
    trpc.organizations.kiloclaw.patchExecPreset.mutationOptions({ onSuccess: invalidateStatus })
  );
  const rawPatchBotIdentity = useMutation(
    trpc.organizations.kiloclaw.patchBotIdentity.mutationOptions({ onSuccess: invalidateStatus })
  );
  const rawPatchOpenclawConfig = useMutation(
    trpc.organizations.kiloclaw.patchOpenclawConfig.mutationOptions()
  );
  const rawRename = useMutation(
    trpc.organizations.kiloclaw.renameInstance.mutationOptions({ onSuccess: invalidateStatus })
  );
  const rawDisconnectGoogle = useMutation(
    trpc.organizations.kiloclaw.disconnectGoogle.mutationOptions({ onSuccess: invalidateStatus })
  );
  const rawSetGmailNotifications = useMutation(
    trpc.organizations.kiloclaw.setGmailNotifications.mutationOptions({
      onSuccess: invalidateStatus,
    })
  );
  const rawStartKiloCliRun = useMutation(
    trpc.organizations.kiloclaw.startKiloCliRun.mutationOptions({
      onSuccess: async () => {
        await invalidateStatus();
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.listKiloCliRuns.queryKey(),
        });
      },
    })
  );
  const rawCancelKiloCliRun = useMutation(
    trpc.organizations.kiloclaw.cancelKiloCliRun.mutationOptions({ onSuccess: invalidateStatus })
  );

  return {
    start: bindVoid(rawStart),
    stop: bindVoid(rawStop),
    destroy: bindVoid(rawDestroy),
    provision: bind(rawProvision),
    cycleInboundEmailAddress: bindVoid(rawCycleInboundEmailAddress),
    patchConfig: bind(rawPatchConfig),
    updateConfig: bind(rawUpdateConfig),
    updateKiloCodeConfig: bind(rawUpdateKiloCodeConfig),
    patchChannels: bind(rawPatchChannels),
    patchSecrets: bind(rawPatchSecrets),
    restartMachine: bind(rawRestartMachine),
    restartOpenClaw: bindVoid(rawRestartOpenClaw),
    approvePairingRequest: bind(rawApprovePairing),
    approveDevicePairingRequest: bind(rawApproveDevicePairing),
    runDoctor: bindVoid(rawRunDoctor),
    restoreConfig: bindVoid(rawRestoreConfig),
    setMyPin: bind(rawSetMyPin),
    removeMyPin: bindVoid(rawRemoveMyPin),
    writeFile: bind(rawWriteFile),
    patchExecPreset: bind(rawPatchExecPreset),
    patchBotIdentity: bind(rawPatchBotIdentity),
    patchOpenclawConfig: bind(rawPatchOpenclawConfig),
    disconnectGoogle: bindVoid(rawDisconnectGoogle),
    setGmailNotifications: bind(rawSetGmailNotifications),
    startKiloCliRun: bind(rawStartKiloCliRun),
    cancelKiloCliRun: bind(rawCancelKiloCliRun),
    rename: bind(rawRename),
  } as unknown as ReturnType<typeof useKiloClawMutations>;
}
