import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc';

export { useKiloClawMutations } from '@/lib/hooks/use-kiloclaw-mutations';
export {
  useKiloClawChannelCatalog,
  useKiloClawConfig,
  useKiloClawGoogleSetup,
  useKiloClawSecretCatalog,
  useStreamChatCredentials,
} from '@/lib/hooks/use-kiloclaw-config';

export type InstanceStatus = NonNullable<ReturnType<typeof useKiloClawStatus>['data']>['status'];
export type GatewayState = NonNullable<
  ReturnType<typeof useKiloClawGatewayStatus>['data']
>['state'];

function orgInput(organizationId?: string | null) {
  return { organizationId: organizationId ?? '' };
}

export function useKiloClawStatus(organizationId?: string | null, enabled = true) {
  const trpc = useTRPC();
  const isResolved = organizationId !== undefined;
  const isOrg = Boolean(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getStatus.queryOptions(undefined, {
      enabled: enabled && isResolved && !isOrg,
      refetchInterval: enabled && isResolved && !isOrg ? 10_000 : false,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getStatus.queryOptions(orgInput(organizationId), {
      enabled: enabled && isResolved && isOrg,
      refetchInterval: enabled && isResolved && isOrg ? 10_000 : false,
    })
  );
  return isOrg ? org : personal;
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

export function useKiloClawGatewayStatus(organizationId?: string | null, enabled = true) {
  const trpc = useTRPC();
  const isResolved = organizationId !== undefined;
  const isOrg = Boolean(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.gatewayStatus.queryOptions(undefined, {
      enabled: enabled && isResolved && !isOrg,
      refetchInterval: enabled && isResolved && !isOrg ? 30_000 : false,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.gatewayStatus.queryOptions(orgInput(organizationId), {
      enabled: enabled && isResolved && isOrg,
      refetchInterval: enabled && isResolved && isOrg ? 30_000 : false,
    })
  );
  return isOrg ? org : personal;
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

export function useKiloClawPairing(organizationId?: string | null, enabled = true) {
  const trpc = useTRPC();
  const isResolved = organizationId !== undefined;
  const isOrg = Boolean(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.listPairingRequests.queryOptions(undefined, {
      enabled: enabled && isResolved && !isOrg,
      refetchInterval: enabled && isResolved && !isOrg ? 120_000 : false,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.listPairingRequests.queryOptions(orgInput(organizationId), {
      enabled: enabled && isResolved && isOrg,
      refetchInterval: enabled && isResolved && isOrg ? 120_000 : false,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawDevicePairing(organizationId?: string | null, enabled = true) {
  const trpc = useTRPC();
  const isResolved = organizationId !== undefined;
  const isOrg = Boolean(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.listDevicePairingRequests.queryOptions(undefined, {
      enabled: enabled && isResolved && !isOrg,
      refetchInterval: enabled && isResolved && !isOrg ? 120_000 : false,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.listDevicePairingRequests.queryOptions(orgInput(organizationId), {
      enabled: enabled && isResolved && isOrg,
      refetchInterval: enabled && isResolved && isOrg ? 120_000 : false,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawAvailableVersions(
  organizationId?: string | null,
  offset = 0,
  limit = 25
) {
  const trpc = useTRPC();
  const isResolved = organizationId !== undefined;
  const isOrg = Boolean(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.listAvailableVersions.queryOptions(
      { offset, limit },
      { enabled: isResolved && !isOrg, staleTime: 5 * 60_000 }
    )
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.listAvailableVersions.queryOptions(
      { ...orgInput(organizationId), offset, limit },
      { enabled: isResolved && isOrg, staleTime: 5 * 60_000 }
    )
  );
  return isOrg ? org : personal;
}

export function useKiloClawMyPin(organizationId?: string | null) {
  const trpc = useTRPC();
  const isResolved = organizationId !== undefined;
  const isOrg = Boolean(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getMyPin.queryOptions(undefined, {
      enabled: isResolved && !isOrg,
      staleTime: 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getMyPin.queryOptions(orgInput(organizationId), {
      enabled: isResolved && isOrg,
      staleTime: 60_000,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawLatestVersion() {
  const trpc = useTRPC();
  return useQuery(trpc.kiloclaw.latestVersion.queryOptions(undefined, { staleTime: 5 * 60_000 }));
}

export function useKiloClawChangelog(organizationId?: string | null) {
  const trpc = useTRPC();
  const isResolved = organizationId !== undefined;
  const isOrg = Boolean(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getChangelog.queryOptions(undefined, {
      enabled: isResolved && !isOrg,
      staleTime: 5 * 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getChangelog.queryOptions(orgInput(organizationId), {
      enabled: isResolved && isOrg,
      staleTime: 5 * 60_000,
    })
  );
  return isOrg ? org : personal;
}
