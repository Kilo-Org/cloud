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
import { useCallback, useEffect, useState } from 'react';

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
  // until a hard refresh, because nothing refetched once the controller was back
  // up. A SHORT window self-heals without a steady poll (refetch on mount, focus,
  // and re-enable as the instance returns to `running` after a restart — a restart
  // is ≥5s, so the cached data is stale by then) plus the existing lifecycle
  // invalidation (invalidateStatus invalidates this query). Not 0: that made a
  // second subscriber mounting right after the page query (e.g. useClawModelOptions
  // on /claw/agents) immediately refire the controller request.
  const STALE_TIME = 5_000;

  const personal = useQuery({
    ...trpc.kiloclaw.controllerVersion.queryOptions(undefined, {
      staleTime: STALE_TIME,
    }),
    enabled: enabled && !organizationId,
  });

  const org = useQuery({
    ...trpc.organizations.kiloclaw.controllerVersion.queryOptions(
      { organizationId: organizationId ?? '' },
      { staleTime: STALE_TIME }
    ),
    enabled: enabled && !!organizationId,
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
 * Controller error codes that map to tRPC INTERNAL_SERVER_ERROR but represent a
 * DEFINITE failure — the mutation did not apply, or left state the controller
 * could not roll back. These must NOT be reconciled into a false success even
 * though they share the INTERNAL_SERVER_ERROR tRPC code with the genuine timeout
 * (`openclaw_cli_timeout`, which may have applied). The router propagates the
 * controller code as `data.upstreamCode` (see handleFileOperationError). Extend
 * this set when adding a new non-reconcilable INTERNAL controller code.
 */
const NON_RECONCILABLE_UPSTREAM_CODES = new Set([
  // The CLI ran but reported failure — the agent/binding write did not land.
  'openclaw_cli_failed',
  // A binding write failed AND the rollback failed — state is uncertain and
  // must surface as an error, never be silently treated as applied.
  'agent_binding_rollback_failed',
]);

/**
 * Whether an agent-mutation error is worth reconciling by refetching: an
 * ambiguous transport/internal failure (e.g. a gateway timeout that may have
 * still applied server-side). Deterministic typed failures — `agent_exists`,
 * `reserved_agent_id`, conflicts, etc. — and EXPLICIT controller failures
 * (`openclaw_cli_failed`, `agent_binding_rollback_failed`) are NOT reconciled,
 * so we never convert a real failure into a false success.
 */
export function isAmbiguousAgentMutationError(err: unknown): boolean {
  if (err instanceof TRPCClientError) {
    const code = err.data?.code as string | undefined;
    // A missing code means TRPCClientError.from wrapped a raw transport failure
    // with no JSON body — a plain-text edge 504 or a dropped connection, i.e.
    // exactly the fire-and-forget timeout the reconcile exists for.
    if (code === undefined) return true;
    if (code === 'TIMEOUT') return true;
    // INTERNAL_SERVER_ERROR is overloaded: it covers genuine gateway/CLI
    // timeouts that MAY have applied (reconcilable) AND explicit controller
    // failures that definitely did not (not reconcilable). The upstream code,
    // when present, disambiguates — only explicit failures are denied.
    if (code === 'INTERNAL_SERVER_ERROR') {
      const upstream = err.data?.upstreamCode as string | undefined;
      return upstream === undefined || !NON_RECONCILABLE_UPSTREAM_CODES.has(upstream);
    }
    // Any other server-originated DETERMINISTIC error (CONFLICT agent_exists,
    // BAD_REQUEST reserved_agent_id, NOT_FOUND, etc.) is never reconciled.
    return false;
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

/**
 * Per-instance "restart required" counter, persisted in localStorage so it
 * survives navigating away / refreshing — the underlying agent config change is
 * persistent and only goes live after a gateway restart, so the warning must
 * outlive the component. `bump` on each saved-but-unapplied change, `clear` after
 * a confirmed restart.
 *
 * Keyed by the Postgres instance id so the count tracks the actual instance
 * whose config changed, not the org/personal context (a since-replaced instance
 * must not inherit a stale count). When the id is unknown (status not yet
 * loaded), fall back to a non-persistent in-memory counter — the warning still
 * works for the session but isn't written under a bogus key.
 */
export function useRestartRequired(instanceId: string | null) {
  const storageKey = instanceId ? `kiloclaw:restart-required:${instanceId}` : null;
  // Init 0 (SSR-safe) and read localStorage on the client to avoid a hydration
  // mismatch; re-read when the storage key changes (incl. id becoming known).
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined' || storageKey === null) return;
    const raw = window.localStorage.getItem(storageKey);
    const n = raw ? Number.parseInt(raw, 10) : 0;
    setCount(Number.isFinite(n) && n > 0 ? n : 0);
  }, [storageKey]);

  const bump = useCallback(() => {
    setCount(prev => {
      const next = prev + 1;
      if (storageKey !== null && typeof window !== 'undefined')
        window.localStorage.setItem(storageKey, String(next));
      return next;
    });
  }, [storageKey]);

  const clear = useCallback(() => {
    setCount(0);
    if (storageKey !== null && typeof window !== 'undefined')
      window.localStorage.removeItem(storageKey);
  }, [storageKey]);

  return { count, bump, clear };
}

/**
 * Agent lifecycle mutations (create / update / delete / bindings / defaults),
 * context-aware. Callers pass the base input; the org variant injects
 * organizationId.
 *
 * Because an agent mutation can time out at the edge gateway AFTER the
 * controller already applied it (fire-and-forget), the list must refresh even on
 * error. Every mutation invalidates on success and reconciles errors via
 * `refetchAgents` in its own catch handler — so the list is fetched exactly once
 * per outcome (no onSettled refresh that would double-fetch on the error path).
 */
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

  // EVERY agent mutation (create/update/delete/bindings/defaults) reconciles in
  // its own catch handler via reconcileAmbiguousMutation, which on an ambiguous
  // failure issues the single authoritative error-path refetch (staleTime: 0).
  // So all of them use success-only invalidation — an onSettled refresh here
  // would fire a SECOND list request on the error path, and each list fetch runs
  // the controller's openclaw agents-bindings subprocess. Success-only keeps it
  // to exactly one refresh per outcome.
  const successOpts = { onSuccess: invalidateAgents };
  const personalCreate = useMutation(trpc.kiloclaw.createAgent.mutationOptions(successOpts));
  const orgCreate = useMutation(
    trpc.organizations.kiloclaw.createAgent.mutationOptions(successOpts)
  );
  const personalUpdate = useMutation(trpc.kiloclaw.updateAgent.mutationOptions(successOpts));
  const orgUpdate = useMutation(
    trpc.organizations.kiloclaw.updateAgent.mutationOptions(successOpts)
  );
  const personalDelete = useMutation(trpc.kiloclaw.deleteAgent.mutationOptions(successOpts));
  const orgDelete = useMutation(
    trpc.organizations.kiloclaw.deleteAgent.mutationOptions(successOpts)
  );
  const personalBindings = useMutation(
    trpc.kiloclaw.updateAgentBindings.mutationOptions(successOpts)
  );
  const orgBindings = useMutation(
    trpc.organizations.kiloclaw.updateAgentBindings.mutationOptions(successOpts)
  );
  const personalDefaults = useMutation(
    trpc.kiloclaw.updateAgentDefaults.mutationOptions(successOpts)
  );
  const orgDefaults = useMutation(
    trpc.organizations.kiloclaw.updateAgentDefaults.mutationOptions(successOpts)
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
