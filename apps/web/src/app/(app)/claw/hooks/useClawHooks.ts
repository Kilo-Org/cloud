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
import { TRPCClientError } from '@trpc/client';
import { useCallback } from 'react';

import { useTRPC } from '@/lib/trpc/utils';
import type {
  AgentBindingsInput,
  AgentCreateInput,
  AgentDefaultsUpdateInput,
  AgentUpdateInput,
} from '@/lib/kiloclaw/agent-schemas';
import type { AgentConfigListResponse } from '@/lib/kiloclaw/types';
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

  // The controller version (and the capabilities it advertises) changes out of
  // band on a redeploy. A long staleTime made the cached capabilities survive an
  // upgrade — e.g. /claw/agents showing "not available on this machine version"
  // until a hard refresh, because the redeploy's invalidation refetched while the
  // controller was still restarting and nothing refetched once it was back up.
  // Keep it short and poll on a bounded interval while running so it self-heals:
  // refetch on mount/re-enable, and pick up the new build within ~30s.
  const STALE_TIME = 0;
  const REFETCH_INTERVAL = 30_000;

  const personal = useQuery({
    ...trpc.kiloclaw.controllerVersion.queryOptions(undefined, {
      staleTime: STALE_TIME,
    }),
    enabled: enabled && !organizationId,
    refetchInterval: enabled && !organizationId ? REFETCH_INTERVAL : false,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.controllerVersion.queryOptions(
      { organizationId: organizationId ?? '' },
      { staleTime: STALE_TIME }
    ),
    enabled: enabled && !!organizationId,
    refetchInterval: enabled && !!organizationId ? REFETCH_INTERVAL : false,
  });

  return organizationId ? org : personal;
}

// Agents (read-only list)

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
 * Agent lifecycle mutations (create / update / delete / bindings), context-aware.
 * Callers pass the base input; the org variant injects organizationId.
 *
 * Because an agent mutation can time out at the edge gateway AFTER the
 * controller already applied it (fire-and-forget), the list must refresh even on
 * error. update/bindings invalidate on settled; create/delete invalidate on
 * success and reconcile errors via `refetchAgents` in their own handlers (so the
 * list isn't fetched twice on a failed create/delete).
 */
/**
 * Whether an agent-mutation error is worth reconciling by refetching: an
 * ambiguous transport/internal failure (e.g. a gateway timeout that may have
 * still applied server-side). Deterministic typed failures — `agent_exists`,
 * `reserved_agent_id`, conflicts, etc. (any non-500 tRPC code) — are NOT
 * reconciled, so we never convert a real conflict into a false success.
 */
export function isAmbiguousAgentMutationError(err: unknown): boolean {
  if (err instanceof TRPCClientError) {
    const code = err.data?.code;
    // A server-originated DETERMINISTIC error (CONFLICT agent_exists,
    // BAD_REQUEST reserved_agent_id, etc.) always carries a `data.code` set by
    // the tRPC error formatter. A missing code means TRPCClientError.from
    // wrapped a raw transport failure with no JSON body — a plain-text edge 504
    // or a dropped connection, i.e. exactly the fire-and-forget timeout the
    // reconcile exists for — so treat undefined as ambiguous too, alongside the
    // explicit timeout/internal codes.
    return code === undefined || code === 'INTERNAL_SERVER_ERROR' || code === 'TIMEOUT';
  }
  // Non-tRPC (e.g. raw thrown) errors: can't classify, treat as ambiguous.
  return true;
}

/**
 * Shared reconcile policy for the fire-and-forget agent create/delete flows. A
 * mutation can time out at the gateway AFTER the controller already applied it;
 * on an AMBIGUOUS error we refetch the list and check whether the intended end
 * state holds. Returns true when the mutation can be treated as applied. A
 * deterministic error (or a refetch failure) returns false so the caller
 * surfaces the original error instead of a false success.
 */
export async function reconcileAmbiguousMutation(
  err: unknown,
  refetch: () => Promise<AgentConfigListResponse>,
  isApplied: (list: AgentConfigListResponse) => boolean
): Promise<boolean> {
  if (!isAmbiguousAgentMutationError(err)) return false;
  try {
    return isApplied(await refetch());
  } catch {
    return false;
  }
}

export function useClawAgentMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { organizationId } = useClawContext();

  const listOptions = organizationId
    ? trpc.organizations.kiloclaw.listAgents.queryOptions({ organizationId })
    : trpc.kiloclaw.listAgents.queryOptions(undefined);

  const invalidateAgents = () => queryClient.invalidateQueries({ queryKey: listOptions.queryKey });
  const refetchAgents = (): Promise<AgentConfigListResponse> =>
    queryClient.fetchQuery({ ...listOptions, staleTime: 0 });

  // create/delete reconcile explicitly in their own catch handlers (they refetch
  // to resolve ambiguous timeouts), so they only need success-path invalidation —
  // avoids a redundant second list fetch on failure.
  const successOpts = { onSuccess: invalidateAgents };
  // update/bindings have no reconcile handler, so refresh on settled (success OR
  // error) to surface a change that a gateway timeout still applied server-side.
  const settledOpts = { onSettled: invalidateAgents };
  const personalCreate = useMutation(trpc.kiloclaw.createAgent.mutationOptions(successOpts));
  const orgCreate = useMutation(
    trpc.organizations.kiloclaw.createAgent.mutationOptions(successOpts)
  );
  const personalUpdate = useMutation(trpc.kiloclaw.updateAgent.mutationOptions(settledOpts));
  const orgUpdate = useMutation(
    trpc.organizations.kiloclaw.updateAgent.mutationOptions(settledOpts)
  );
  const personalDelete = useMutation(trpc.kiloclaw.deleteAgent.mutationOptions(successOpts));
  const orgDelete = useMutation(
    trpc.organizations.kiloclaw.deleteAgent.mutationOptions(successOpts)
  );
  const personalBindings = useMutation(
    trpc.kiloclaw.updateAgentBindings.mutationOptions(settledOpts)
  );
  const orgBindings = useMutation(
    trpc.organizations.kiloclaw.updateAgentBindings.mutationOptions(settledOpts)
  );
  const personalDefaults = useMutation(
    trpc.kiloclaw.updateAgentDefaults.mutationOptions(settledOpts)
  );
  const orgDefaults = useMutation(
    trpc.organizations.kiloclaw.updateAgentDefaults.mutationOptions(settledOpts)
  );

  return {
    refetchAgents,
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
    updateBindings: {
      mutateAsync: (agentId: string, bindings: AgentBindingsInput) =>
        organizationId
          ? orgBindings.mutateAsync({ organizationId, agentId, bindings })
          : personalBindings.mutateAsync({ agentId, bindings }),
      isPending: organizationId ? orgBindings.isPending : personalBindings.isPending,
    },
    updateDefaults: {
      mutateAsync: (patch: AgentDefaultsUpdateInput) =>
        organizationId
          ? orgDefaults.mutateAsync({ organizationId, patch })
          : personalDefaults.mutateAsync(patch),
      isPending: organizationId ? orgDefaults.isPending : personalDefaults.isPending,
    },
  };
}

/** Channel catalog (telegram/discord/slack + `configured`), context-aware. */
export function useClawChannelCatalog(enabled = true) {
  const trpc = useTRPC();
  const { organizationId } = useClawContext();

  const personal = useQuery({
    ...trpc.kiloclaw.getChannelCatalog.queryOptions(undefined),
    enabled: enabled && !organizationId,
  });
  const org = useQuery({
    ...trpc.organizations.kiloclaw.getChannelCatalog.queryOptions({
      organizationId: organizationId ?? '',
    }),
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
