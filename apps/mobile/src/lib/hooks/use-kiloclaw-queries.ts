import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { deriveMobileOnboardingStateFromBilling } from '@/lib/derive-mobile-onboarding-state';
import { resolveContext } from '@/lib/hooks/use-context-query';
import { useTRPC } from '@/lib/trpc';

export { useKiloClawMutations } from '@/lib/hooks/use-kiloclaw-mutations';

export type InstanceStatus = NonNullable<ReturnType<typeof useKiloClawStatus>['data']>['status'];
export type GatewayState = NonNullable<
  ReturnType<typeof useKiloClawGatewayStatus>['data']
>['state'];

export function useKiloClawStatus(
  organizationId?: string | null,
  enabled = true,
  pollIntervalMs = 10_000
) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId, enabled);
  const personal = useQuery(
    trpc.kiloclaw.getStatus.queryOptions(undefined, {
      enabled: personalEnabled,
      refetchInterval: personalEnabled ? pollIntervalMs : false,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getStatus.queryOptions(orgInput, {
      enabled: orgEnabled,
      refetchInterval: orgEnabled ? pollIntervalMs : false,
    })
  );
  return isOrg ? org : personal;
}

/**
 * Query key for `useKiloClawStatus` — personal vs. org namespace mirrors
 * the subscribing hook above. Exported so non-subscribing peeks
 * (`queryClient.getQueryData`) stay in sync with the hook.
 */
export function useKiloClawStatusQueryKey(organizationId: string | null) {
  const trpc = useTRPC();
  return organizationId
    ? trpc.organizations.kiloclaw.getStatus.queryKey({ organizationId })
    : trpc.kiloclaw.getStatus.queryKey();
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

/**
 * Mobile KiloClaw onboarding state, derived client-side from
 * `getBillingStatus`. See `lib/derive-mobile-onboarding-state.ts` for scope
 * and limitations.
 */
export function useKiloClawMobileOnboardingState(enabled = true) {
  const billing = useKiloClawBillingStatus(enabled);
  const data = useMemo(() => {
    if (!billing.data) {
      return undefined;
    }
    return deriveMobileOnboardingStateFromBilling(billing.data);
  }, [billing.data]);

  // React Query keeps `isPending: true` on disabled queries with no cached
  // data. Callers that gate skeletons on `isPending` would be stuck forever
  // when this hook is used with `enabled=false`. Treat disabled-without-data
  // as "not pending" so the consumer falls through to the non-loading branch.
  const isPending = enabled ? billing.isPending : false;

  return {
    data,
    isPending,
    isError: billing.isError,
    refetch: billing.refetch,
  };
}

export function useKiloClawGatewayStatus(organizationId?: string | null, enabled = true) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId, enabled);
  const personal = useQuery(
    trpc.kiloclaw.gatewayStatus.queryOptions(undefined, {
      enabled: personalEnabled,
      refetchInterval: personalEnabled ? 30_000 : false,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.gatewayStatus.queryOptions(orgInput, {
      enabled: orgEnabled,
      refetchInterval: orgEnabled ? 30_000 : false,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawGatewayReady(organizationId?: string | null, enabled = true) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId, enabled);
  const personal = useQuery(
    trpc.kiloclaw.gatewayReady.queryOptions(undefined, {
      enabled: personalEnabled,
      refetchInterval: personalEnabled ? 5000 : false,
      refetchIntervalInBackground: true,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.gatewayReady.queryOptions(orgInput, {
      enabled: orgEnabled,
      refetchInterval: orgEnabled ? 5000 : false,
      refetchIntervalInBackground: true,
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

export function useKiloClawPairing(
  organizationId?: string | null,
  enabled = true,
  pollIntervalMs = 120_000
) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId, enabled);
  const personal = useQuery(
    trpc.kiloclaw.listPairingRequests.queryOptions(undefined, {
      enabled: personalEnabled,
      refetchInterval: personalEnabled ? pollIntervalMs : false,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.listPairingRequests.queryOptions(orgInput, {
      enabled: orgEnabled,
      refetchInterval: orgEnabled ? pollIntervalMs : false,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawDevicePairing(organizationId?: string | null, enabled = true) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId, enabled);
  const personal = useQuery(
    trpc.kiloclaw.listDevicePairingRequests.queryOptions(undefined, {
      enabled: personalEnabled,
      refetchInterval: personalEnabled ? 120_000 : false,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.listDevicePairingRequests.queryOptions(orgInput, {
      enabled: orgEnabled,
      refetchInterval: orgEnabled ? 120_000 : false,
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
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.listAvailableVersions.queryOptions(
      { offset, limit },
      { enabled: personalEnabled, staleTime: 5 * 60_000 }
    )
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.listAvailableVersions.queryOptions(
      { ...orgInput, offset, limit },
      { enabled: orgEnabled, staleTime: 5 * 60_000 }
    )
  );
  return isOrg ? org : personal;
}

export function useKiloClawMyPin(organizationId?: string | null) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getMyPin.queryOptions(undefined, {
      enabled: personalEnabled,
      staleTime: 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getMyPin.queryOptions(orgInput, {
      enabled: orgEnabled,
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
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getChangelog.queryOptions(undefined, {
      enabled: personalEnabled,
      staleTime: 5 * 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getChangelog.queryOptions(orgInput, {
      enabled: orgEnabled,
      staleTime: 5 * 60_000,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawGoogleSetup(organizationId?: string | null, enabled = true) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId, enabled);
  const personal = useQuery(
    trpc.kiloclaw.getGoogleSetupCommand.queryOptions(undefined, {
      enabled: personalEnabled,
      staleTime: 50 * 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getGoogleSetupCommand.queryOptions(orgInput, {
      enabled: orgEnabled,
      staleTime: 50 * 60_000,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawChannelCatalog(organizationId?: string | null) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getChannelCatalog.queryOptions(undefined, {
      enabled: personalEnabled,
      staleTime: 5 * 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getChannelCatalog.queryOptions(orgInput, {
      enabled: orgEnabled,
      staleTime: 5 * 60_000,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawSecretCatalog(organizationId?: string | null) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getSecretCatalog.queryOptions(undefined, {
      enabled: personalEnabled,
      staleTime: 5 * 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getSecretCatalog.queryOptions(orgInput, {
      enabled: orgEnabled,
      staleTime: 5 * 60_000,
    })
  );
  return isOrg ? org : personal;
}

export function useStreamChatCredentials(organizationId?: string | null, enabled = true) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId, enabled);
  const personal = useQuery(
    trpc.kiloclaw.getStreamChatCredentials.queryOptions(undefined, {
      enabled: personalEnabled,
      staleTime: 5 * 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getStreamChatCredentials.queryOptions(orgInput, {
      enabled: orgEnabled,
      staleTime: 5 * 60_000,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawConfig(organizationId?: string | null) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getConfig.queryOptions(undefined, {
      enabled: personalEnabled,
      staleTime: 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getConfig.queryOptions(orgInput, {
      enabled: orgEnabled,
      staleTime: 60_000,
    })
  );
  return isOrg ? org : personal;
}
