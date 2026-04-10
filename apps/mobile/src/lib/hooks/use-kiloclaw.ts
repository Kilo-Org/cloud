import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc';

export { useKiloClawMutations } from '@/lib/hooks/use-kiloclaw-mutations';

export type InstanceStatus = NonNullable<ReturnType<typeof useKiloClawStatus>['data']>['status'];
export type GatewayState = NonNullable<
  ReturnType<typeof useKiloClawGatewayStatus>['data']
>['state'];

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

export function useKiloClawConfig() {
  const trpc = useTRPC();
  return useQuery(
    trpc.kiloclaw.getConfig.queryOptions(undefined, {
      staleTime: 60_000,
    })
  );
}
