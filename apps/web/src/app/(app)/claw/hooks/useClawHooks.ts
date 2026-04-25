'use client';

/**
 * Dispatcher hooks that route to personal or org hooks based on ClawContext.
 *
 * Each hook calls BOTH the personal and org variant unconditionally,
 * but only one is `enabled`. This satisfies the React hook rules
 * (hooks are always called, in the same order) while directing
 * the actual network request to the correct tRPC route.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc/utils';
import { useClawContext } from '../components/ClawContext';

// Config

export function useClawConfig() {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.getConfig.queryOptions(),
    enabled: !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.getConfig.queryOptions({ organizationId: organizationId ?? '' }),
    enabled: !!organizationId,
  });

  return organizationId ? org : personal;
}

// Disk usage

export function getClawDiskUsageQueryOptions(
  trpc: ReturnType<typeof useTRPC>,
  organizationId: string | undefined,
  enabled: boolean
) {
  const personal = {
    ...trpc.kiloclaw.getDiskUsage.queryOptions(undefined, {
      refetchInterval: 60_000,
    }),
    enabled: enabled && !organizationId,
  };

  const org = {
    ...trpc.organizations.kiloclaw.getDiskUsage.queryOptions(
      { organizationId: organizationId ?? '' },
      { refetchInterval: 60_000 }
    ),
    enabled: enabled && !!organizationId,
  };

  return { personal, org, active: organizationId ? org : personal };
}

export function useClawDiskUsage(enabled: boolean) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();
  const { personal, org } = getClawDiskUsageQueryOptions(trpc, organizationId, enabled);

  const personalQuery = useQuery(personal);
  const orgQuery = useQuery(org);

  return organizationId ? orgQuery : personalQuery;
}

// Controller version

export function useClawControllerVersion(enabled: boolean) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.controllerVersion.queryOptions(undefined, {
      staleTime: 5 * 60_000,
    }),
    enabled: enabled && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.controllerVersion.queryOptions(
      { organizationId: organizationId ?? '' },
      { staleTime: 5 * 60_000 }
    ),
    enabled: enabled && !!organizationId,
  });

  return organizationId ? org : personal;
}

export function useClawMorningBriefingStatus(enabled: boolean) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const getRefetchInterval = (data: unknown): number => {
    const maybeCode =
      typeof data === 'object' && data !== null && 'code' in data
        ? (data as { code?: unknown }).code
        : undefined;
    return maybeCode === 'gateway_warming_up' ? 10_000 : 30_000;
  };

  const personal = useQuery({
    ...trpc.kiloclaw.getMorningBriefingStatus.queryOptions(undefined, {
      refetchInterval: query => (enabled ? getRefetchInterval(query.state.data) : false),
      retry: false,
    }),
    enabled: enabled && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.getMorningBriefingStatus.queryOptions(
      { organizationId: organizationId ?? '' },
      {
        refetchInterval: query => (enabled ? getRefetchInterval(query.state.data) : false),
        retry: false,
      }
    ),
    enabled: enabled && !!organizationId,
  });

  return organizationId ? org : personal;
}

export function useClawReadMorningBriefing(day: 'today' | 'yesterday' | null, enabled: boolean) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.readMorningBriefing.queryOptions(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by enabled
      { day: day! },
      { refetchOnWindowFocus: false }
    ),
    enabled: enabled && day !== null && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.readMorningBriefing.queryOptions(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by enabled
      { organizationId: organizationId ?? '', day: day! },
      { refetchOnWindowFocus: false }
    ),
    enabled: enabled && day !== null && !!organizationId,
  });

  return organizationId ? org : personal;
}

// Pairing

export function useClawPairing(enabled = true) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.listPairingRequests.queryOptions(undefined, {
      refetchInterval: enabled ? 120_000 : false,
    }),
    enabled: enabled && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.listPairingRequests.queryOptions(
      { organizationId: organizationId ?? '' },
      { refetchInterval: enabled ? 120_000 : false }
    ),
    enabled: enabled && !!organizationId,
  });

  return organizationId ? org : personal;
}

export function useClawRefreshPairing() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { organizationId } = useClawContext();

  return async () => {
    if (organizationId) {
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
    } else {
      const fresh = await queryClient.fetchQuery(
        trpc.kiloclaw.listPairingRequests.queryOptions({ refresh: true }, { staleTime: 0 })
      );
      queryClient.setQueryData(trpc.kiloclaw.listPairingRequests.queryKey(), fresh);
    }
  };
}

export function useClawDevicePairing(enabled = true) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.listDevicePairingRequests.queryOptions(undefined, {
      refetchInterval: enabled ? 120_000 : false,
    }),
    enabled: enabled && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.listDevicePairingRequests.queryOptions(
      { organizationId: organizationId ?? '' },
      { refetchInterval: enabled ? 120_000 : false }
    ),
    enabled: enabled && !!organizationId,
  });

  return organizationId ? org : personal;
}

export function useClawRefreshDevicePairing() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { organizationId } = useClawContext();

  return async () => {
    if (organizationId) {
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
    } else {
      const fresh = await queryClient.fetchQuery(
        trpc.kiloclaw.listDevicePairingRequests.queryOptions({ refresh: true })
      );
      queryClient.setQueryData(trpc.kiloclaw.listDevicePairingRequests.queryKey(), fresh);
    }
  };
}

// Version pinning

export function useClawMyPin() {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.getMyPin.queryOptions(undefined, { staleTime: 60_000 }),
    enabled: !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.getMyPin.queryOptions(
      { organizationId: organizationId ?? '' },
      { staleTime: 60_000 }
    ),
    enabled: !!organizationId,
  });

  return organizationId ? org : personal;
}

export function useClawLatestVersion() {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.latestVersion.queryOptions(undefined, { staleTime: 60_000 }),
    enabled: !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.latestVersion.queryOptions(
      { organizationId: organizationId ?? '' },
      { staleTime: 60_000 }
    ),
    enabled: !!organizationId,
  });

  return organizationId ? org : personal;
}

export function useClawAvailableVersions(offset = 0, limit = 25) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.listAvailableVersions.queryOptions(
      { offset, limit },
      { staleTime: 5 * 60_000 }
    ),
    enabled: !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.listAvailableVersions.queryOptions(
      { organizationId: organizationId ?? '', offset, limit },
      { staleTime: 5 * 60_000 }
    ),
    enabled: !!organizationId,
  });

  return organizationId ? org : personal;
}

// Gateway

export function useClawGatewayReady(enabled: boolean) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.gatewayReady.queryOptions(undefined, {
      refetchInterval: enabled ? 5_000 : false,
      refetchIntervalInBackground: true,
    }),
    enabled: enabled && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.gatewayReady.queryOptions(
      { organizationId: organizationId ?? '' },
      { refetchInterval: enabled ? 5_000 : false, refetchIntervalInBackground: true }
    ),
    enabled: enabled && !!organizationId,
  });

  return organizationId ? org : personal;
}

// File operations

export function useClawFileTree(enabled: boolean) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.fileTree.queryOptions(undefined, { refetchOnWindowFocus: false }),
    enabled: enabled && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.fileTree.queryOptions(
      { organizationId: organizationId ?? '' },
      { refetchOnWindowFocus: false }
    ),
    enabled: enabled && !!organizationId,
  });

  return organizationId ? org : personal;
}

export function useClawReadFile(path: string | null, enabled: boolean) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.readFile.queryOptions(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by enabled
      { path: path! },
      { refetchOnWindowFocus: false, refetchOnMount: 'always' }
    ),
    enabled: enabled && path !== null && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.readFile.queryOptions(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by enabled
      { organizationId: organizationId ?? '', path: path! },
      { refetchOnWindowFocus: false, refetchOnMount: 'always' }
    ),
    enabled: enabled && path !== null && !!organizationId,
  });

  return organizationId ? org : personal;
}

// Google integration

export function useClawGoogleSetupCommand(enabled: boolean) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.getGoogleSetupCommand.queryOptions(undefined, {
      refetchInterval: 50 * 60 * 1000,
      refetchOnWindowFocus: false,
    }),
    enabled: enabled && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.getGoogleSetupCommand.queryOptions(
      { organizationId: organizationId ?? '' },
      { refetchInterval: 50 * 60 * 1000, refetchOnWindowFocus: false }
    ),
    enabled: enabled && !!organizationId,
  });

  return organizationId ? org : personal;
}

// Stream Chat

export function useClawStreamChatCredentials(enabled: boolean) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.getStreamChatCredentials.queryOptions(undefined, {
      staleTime: 5 * 60_000,
    }),
    enabled: enabled && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.getStreamChatCredentials.queryOptions(
      { organizationId: organizationId ?? '' },
      { staleTime: 5 * 60_000 }
    ),
    enabled: enabled && !!organizationId,
  });

  return organizationId ? org : personal;
}

// Kilo CLI Run

export function useClawKiloCliRunStatus(runId: string | null) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.getKiloCliRunStatus.queryOptions(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by enabled
      { runId: runId! },
      { refetchInterval: runId !== null ? 3_000 : false }
    ),
    enabled: runId !== null && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.getKiloCliRunStatus.queryOptions(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by enabled
      { organizationId: organizationId ?? '', runId: runId! },
      { refetchInterval: runId !== null ? 3_000 : false }
    ),
    enabled: runId !== null && !!organizationId,
  });

  return organizationId ? org : personal;
}

export function useClawKiloCliRunHistory(enabled: boolean) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.listKiloCliRuns.queryOptions(undefined, {
      staleTime: 30_000,
    }),
    enabled: enabled && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.listKiloCliRuns.queryOptions(
      { organizationId: organizationId ?? '' },
      { staleTime: 30_000 }
    ),
    enabled: enabled && !!organizationId,
  });

  return organizationId ? org : personal;
}

// Service status

export function useClawServiceDegraded() {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.serviceDegraded.queryOptions(undefined, {
      staleTime: 60_000,
      refetchInterval: 60_000,
    }),
    enabled: !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.serviceDegraded.queryOptions(
      { organizationId: organizationId ?? '' },
      { staleTime: 60_000, refetchInterval: 60_000 }
    ),
    enabled: !!organizationId,
  });

  return organizationId ? org : personal;
}
