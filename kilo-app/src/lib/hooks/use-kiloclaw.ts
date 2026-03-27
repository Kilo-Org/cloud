import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';

// ── Derived types ───────────────────────────────────────────────────

export type InstanceStatus = NonNullable<ReturnType<typeof useKiloClawStatus>['data']>['status'];
export type GatewayState = NonNullable<
  ReturnType<typeof useKiloClawGatewayStatus>['data']
>['state'];

// ── Queries ──────────────────────────────────────────────────────────

export function useKiloClawStatus(enabled = true) {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.getStatus.queryOptions(undefined, {
      enabled,
      refetchInterval: enabled ? 10_000 : false,
    })
  );
}

export function useKiloClawBillingStatus(enabled = true) {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.getBillingStatus.queryOptions(undefined, {
      enabled,
      refetchInterval: enabled ? 60_000 : false,
    })
  );
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

export function useKiloClawServiceDegraded() {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.serviceDegraded.queryOptions(undefined, {
      staleTime: 60_000,
      refetchInterval: 60_000,
    })
  );
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

export function useKiloClawDevicePairing(enabled = true) {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.listDevicePairingRequests.queryOptions(undefined, {
      enabled,
      refetchInterval: enabled ? 120_000 : false,
    })
  );
}

export function useKiloClawAvailableVersions(offset = 0, limit = 25) {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.listAvailableVersions.queryOptions({ offset, limit }, { staleTime: 5 * 60_000 })
  );
}

export function useKiloClawMyPin() {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.getMyPin.queryOptions(undefined, {
      staleTime: 60_000,
    })
  );
}

export function useKiloClawLatestVersion() {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.latestVersion.queryOptions(undefined, {
      staleTime: 5 * 60_000,
    })
  );
}

export function useKiloClawGoogleSetup(enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.getGoogleSetupCommand.queryOptions(undefined, {
      enabled,
      staleTime: 50 * 60_000,
    })
  );
}

export function useKiloClawChangelog() {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.getChangelog.queryOptions(undefined, {
      staleTime: 5 * 60_000,
    })
  );
}

export function useKiloClawChannelCatalog() {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.getChannelCatalog.queryOptions(undefined, {
      staleTime: 5 * 60_000,
    })
  );
}

export function useKiloClawSecretCatalog() {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.getSecretCatalog.queryOptions(undefined, {
      staleTime: 5 * 60_000,
    })
  );
}

export function useStreamChatCredentials(enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.getStreamChatCredentials.queryOptions(undefined, {
      enabled,
      staleTime: 5 * 60_000,
    })
  );
}

// ── Mutations ────────────────────────────────────────────────────────

const onMutationError = (error: { message: string }) => {
  toast.error(error.message || 'Something went wrong');
};

export function useKiloClawMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const invalidateStatus = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.kiloclaw.getStatus.queryKey() });
    await queryClient.invalidateQueries({
      queryKey: trpc.kiloclaw.controllerVersion.queryKey(),
    });
  };

  return {
    start: useMutation(
      trpc.kiloclaw.start.mutationOptions({ onSuccess: invalidateStatus, onError: onMutationError })
    ),
    stop: useMutation(
      trpc.kiloclaw.stop.mutationOptions({ onSuccess: invalidateStatus, onError: onMutationError })
    ),
    restartMachine: useMutation(
      trpc.kiloclaw.restartMachine.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.gatewayStatus.queryKey(),
          });
        },
        onError: onMutationError,
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
        onError: onMutationError,
      })
    ),
    patchSecrets: useMutation(
      trpc.kiloclaw.patchSecrets.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({ queryKey: trpc.kiloclaw.getConfig.queryKey() });
          // Small delay to let the worker process the secret before refetching catalog
          await new Promise<void>(resolve => {
            setTimeout(resolve, 1000);
          });
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.getSecretCatalog.queryKey(),
          });
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.getChannelCatalog.queryKey(),
          });
        },
        onError: onMutationError,
      })
    ),
    patchChannels: useMutation(
      trpc.kiloclaw.patchChannels.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({ queryKey: trpc.kiloclaw.getConfig.queryKey() });
          await new Promise<void>(resolve => {
            setTimeout(resolve, 1000);
          });
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.getChannelCatalog.queryKey(),
          });
        },
        onError: onMutationError,
      })
    ),
    patchExecPreset: useMutation(
      trpc.kiloclaw.patchExecPreset.mutationOptions({
        onSuccess: invalidateStatus,
        onError: onMutationError,
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
        onError: onMutationError,
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
        onError: onMutationError,
      })
    ),
    approvePairingRequest: useMutation(
      trpc.kiloclaw.approvePairingRequest.mutationOptions({
        onSuccess: async () => {
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.listPairingRequests.queryKey(),
          });
        },
        onError: onMutationError,
      })
    ),
    approveDevicePairingRequest: useMutation(
      trpc.kiloclaw.approveDevicePairingRequest.mutationOptions({
        onSuccess: async () => {
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.listDevicePairingRequests.queryKey(),
          });
        },
        onError: onMutationError,
      })
    ),
    disconnectGoogle: useMutation(
      trpc.kiloclaw.disconnectGoogle.mutationOptions({
        onSuccess: invalidateStatus,
        onError: onMutationError,
      })
    ),
    setGmailNotifications: useMutation(
      trpc.kiloclaw.setGmailNotifications.mutationOptions({
        onSuccess: invalidateStatus,
        onError: onMutationError,
      })
    ),
    renameInstance: useMutation(
      trpc.kiloclaw.renameInstance.mutationOptions({
        onSuccess: invalidateStatus,
        onError: onMutationError,
      })
    ),
    destroy: useMutation(
      trpc.kiloclaw.destroy.mutationOptions({
        onSuccess: invalidateStatus,
        onError: onMutationError,
      })
    ),
  };
}
