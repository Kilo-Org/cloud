'use client';

/**
 * Dispatcher hooks that route to personal or org hooks based on ClawContext.
 *
 * Each hook calls BOTH the personal and org variant unconditionally,
 * but only one is `enabled`. This satisfies the React hook rules
 * (hooks are always called, in the same order) while directing
 * the actual network request to the correct tRPC route.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useTRPC } from '@/lib/trpc/utils';
import type { AgentCreateInput, AgentUpdateInput } from '@/lib/kiloclaw/agent-schemas';
import { useClawContext } from '../components/ClawContext';

// Config

export function useClawConfig(enabled = true) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.getConfig.queryOptions(),
    enabled: enabled && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.getConfig.queryOptions({ organizationId: organizationId ?? '' }),
    enabled: enabled && !!organizationId,
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

// Agents (read-only fleet)

export function useClawAgents(enabled = true) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.listAgents.queryOptions(undefined),
    enabled: enabled && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.listAgents.queryOptions({
      organizationId: organizationId ?? '',
    }),
    enabled: enabled && !!organizationId,
  });

  return organizationId ? org : personal;
}

/**
 * Agent lifecycle mutations (create / update / delete), context-aware. Callers
 * pass the base input; the org variant injects organizationId. Each mutation
 * invalidates the active listAgents query on success.
 */
export function useClawAgentMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { organizationId } = useClawContext();

  const invalidateAgents = () =>
    queryClient.invalidateQueries({
      queryKey: organizationId
        ? trpc.organizations.kiloclaw.listAgents.queryKey({ organizationId })
        : trpc.kiloclaw.listAgents.queryKey(),
    });

  const personalCreate = useMutation(
    trpc.kiloclaw.createAgent.mutationOptions({ onSuccess: invalidateAgents })
  );
  const orgCreate = useMutation(
    trpc.organizations.kiloclaw.createAgent.mutationOptions({ onSuccess: invalidateAgents })
  );
  const personalUpdate = useMutation(
    trpc.kiloclaw.updateAgent.mutationOptions({ onSuccess: invalidateAgents })
  );
  const orgUpdate = useMutation(
    trpc.organizations.kiloclaw.updateAgent.mutationOptions({ onSuccess: invalidateAgents })
  );
  const personalDelete = useMutation(
    trpc.kiloclaw.deleteAgent.mutationOptions({ onSuccess: invalidateAgents })
  );
  const orgDelete = useMutation(
    trpc.organizations.kiloclaw.deleteAgent.mutationOptions({ onSuccess: invalidateAgents })
  );

  return {
    createAgent: {
      mutateAsync: (input: AgentCreateInput) =>
        organizationId
          ? orgCreate.mutateAsync({ organizationId, agent: input })
          : personalCreate.mutateAsync(input),
      isPending: organizationId ? orgCreate.isPending : personalCreate.isPending,
    },
    updateAgent: {
      mutateAsync: (agentId: string, patch: AgentUpdateInput) =>
        organizationId
          ? orgUpdate.mutateAsync({ organizationId, agentId, patch })
          : personalUpdate.mutateAsync({ agentId, patch }),
      isPending: organizationId ? orgUpdate.isPending : personalUpdate.isPending,
    },
    deleteAgent: {
      mutateAsync: (agentId: string) =>
        organizationId
          ? orgDelete.mutateAsync({ organizationId, agentId })
          : personalDelete.mutateAsync({ agentId }),
      isPending: organizationId ? orgDelete.isPending : personalDelete.isPending,
    },
  };
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

export function useClawLatestVersion(currentImageTag?: string | null) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  // Pass currentImageTag to the resolver so it can suppress false upgrade
  // offers when the instance is already on the candidate (or otherwise on
  // the resolver's chosen image). Without this the banner can surface a
  // downgrade after a slider rollback.
  const input = currentImageTag ? { currentImageTag } : undefined;

  const personal = useQuery({
    ...trpc.kiloclaw.latestVersion.queryOptions(input, { staleTime: 60_000 }),
    enabled: !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.latestVersion.queryOptions(
      { organizationId: organizationId ?? '', currentImageTag: currentImageTag ?? undefined },
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

export function useClawFileTree(enabled: boolean, path?: string) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.fileTree.queryOptions(path === undefined ? undefined : { path }, {
      refetchOnWindowFocus: false,
    }),
    enabled: enabled && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.fileTree.queryOptions(
      { organizationId: organizationId ?? '', ...(path === undefined ? {} : { path }) },
      { refetchOnWindowFocus: false }
    ),
    enabled: enabled && !!organizationId,
  });

  return organizationId ? org : personal;
}

export function useClawFileTreeLoader(enabled: boolean) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { organizationId } = useClawContext();

  return useCallback(
    async (path: string) => {
      if (!enabled) return [];

      if (organizationId) {
        return await queryClient.fetchQuery(
          trpc.organizations.kiloclaw.fileTree.queryOptions(
            { organizationId, path },
            { refetchOnWindowFocus: false }
          )
        );
      }

      return await queryClient.fetchQuery(
        trpc.kiloclaw.fileTree.queryOptions({ path }, { refetchOnWindowFocus: false })
      );
    },
    [enabled, organizationId, queryClient, trpc]
  );
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
