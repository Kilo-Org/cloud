import {
  canManageSecurityAgent,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';

import { type SecurityAgentConfig } from '@/lib/security-agent';
import { useTRPC } from '@/lib/trpc';

// Mutation hooks (save config, set enabled, trigger sync, track interaction)
// live in use-security-agent-mutations.ts — split out to stay under the
// 300-line file limit. Re-exported here so existing call sites importing
// from this module are unaffected.
export {
  useSaveSecurityAgentConfig,
  useSetSecurityAgentEnabled,
  useTrackSecurityAgentInteraction,
  useTriggerSecuritySync,
} from '@/lib/hooks/use-security-agent-mutations';

// Personal and org procedures resolve to nominally distinct tRPC option
// types even when structurally identical, so we can't pick between them
// with a ternary and spread the result — we always call both hooks (one
// disabled) and return whichever is active. See use-code-reviewer.ts:32.

export function useSecurityAgentPermissionStatus(scope: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getPermissionStatus.queryOptions(),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getPermissionStatus.queryOptions({
      organizationId: scope,
    }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return isPersonalSecurityScope(scope) ? personal : organization;
}

export function useSecurityAgentConfig(scope: string): UseQueryResult<SecurityAgentConfig> {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getConfig.queryOptions(),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getConfig.queryOptions({ organizationId: scope }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return (
    isPersonalSecurityScope(scope) ? personal : organization
  ) as UseQueryResult<SecurityAgentConfig>;
}

export function useSecurityAgentRepositories(scope: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getRepositories.queryOptions(),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getRepositories.queryOptions({ organizationId: scope }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return isPersonalSecurityScope(scope) ? personal : organization;
}

export function useRetrySecurityAgentSettings(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [isRetrying, setIsRetrying] = useState(false);
  const retry = async () => {
    if (isRetrying) {
      return;
    }
    setIsRetrying(true);
    const keys = isPersonalSecurityScope(scope)
      ? [
          trpc.securityAgent.getPermissionStatus.queryKey(),
          trpc.securityAgent.getConfig.queryKey(),
          trpc.securityAgent.getRepositories.queryKey(),
        ]
      : [
          trpc.organizations.securityAgent.getPermissionStatus.queryKey({ organizationId: scope }),
          trpc.organizations.securityAgent.getConfig.queryKey({ organizationId: scope }),
          trpc.organizations.securityAgent.getRepositories.queryKey({ organizationId: scope }),
          trpc.organizations.list.queryKey(),
        ];
    await Promise.allSettled(
      keys.map(async queryKey => {
        const query = queryClient.getQueryCache().find({ queryKey, exact: true });
        if (!query) {
          return;
        }
        const options = query.options;
        // An uncached refetch reuses its paused promise, even with cancelRefetch.
        // Cancel first, then bypass NetInfo for this deliberate attempt only.
        await queryClient.cancelQueries({ queryKey, exact: true });
        try {
          await queryClient.fetchQuery({
            ...options,
            queryKey,
            networkMode: 'always',
            retry: false,
            staleTime: 0,
          });
        } finally {
          query.setOptions(options);
        }
      })
    );
    // Each query retains its own error; wait for every request to settle before
    // allowing another attempt. The existing tRPC transport bounds request time.
    setIsRetrying(false);
  };
  return { retry, isRetrying };
}

export function useSecurityAgentDashboardStats(scope: string, repoFullName?: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getDashboardStats.queryOptions({ repoFullName }),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getDashboardStats.queryOptions({
      organizationId: scope,
      repoFullName,
    }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return isPersonalSecurityScope(scope) ? personal : organization;
}

export function useSecurityAgentLastSyncTime(scope: string, repoFullName?: string) {
  const trpc = useTRPC();
  const personal = useQuery({
    ...trpc.securityAgent.getLastSyncTime.queryOptions({ repoFullName }),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.getLastSyncTime.queryOptions({
      organizationId: scope,
      repoFullName,
    }),
    enabled: !isPersonalSecurityScope(scope),
  });
  return isPersonalSecurityScope(scope) ? personal : organization;
}

// Personal scope always has full access; for an organization, only owner and
// billing_manager can manage config. `organizations.list` is already fetched
// app-wide for the org switcher, so this reuses that cache rather than adding
// a new procedure (mirrors useCanEditReviewer in use-code-reviewer.ts:234).
//
// A real org-scope fetch failure otherwise collapses into the same
// `undefined` role as "still loading" and "genuinely unauthorized", which
// callers used to read as permission-denied. `useSecurityAgentCapability`
// below tells those apart; it's the only exported consumer of this query.
function useSecurityAgentOrgRoleQuery(scope: string) {
  const trpc = useTRPC();
  const isPersonal = isPersonalSecurityScope(scope);
  const query = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: !isPersonal,
  });
  if (isPersonal) {
    // The org list is irrelevant to the personal scope, but even a disabled
    // observer surfaces the SHARED cache entry's error state (populated
    // app-wide, e.g. by Profile) — mask it so an organizations.list outage
    // can never block the personal Security Agent.
    return {
      role: undefined,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: query.refetch,
      hasData: true,
      isPending: false,
      fetchStatus: 'idle' as const,
    };
  }
  return {
    role: query.data?.find(org => org.organizationId === scope)?.role,
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching: query.isFetching,
    refetch: query.refetch,
    hasData: query.data !== undefined,
    isPending: query.isPending,
    fetchStatus: query.fetchStatus,
  };
}

// Discriminated capability state for consumers (e.g. audit-report access)
// that must distinguish "still loading"/"failed to load" from "resolved:
// no access" instead of treating an undefined role as permission-denied.
type SecurityAgentCapabilityStatus = 'loading' | 'error' | 'denied' | 'allowed';

export function useSecurityAgentCapability(scope: string) {
  const { role, isLoading, isError, isFetching, refetch, hasData, isPending, fetchStatus } =
    useSecurityAgentOrgRoleQuery(scope);
  const canManage = canManageSecurityAgent(scope, role);

  let status: SecurityAgentCapabilityStatus = 'loading';
  if (isPersonalSecurityScope(scope)) {
    status = 'allowed';
  } else if (hasData) {
    // A settled role stays authoritative: a failed background refetch must
    // never demote an already-resolved capability to 'error'.
    status = canManage ? 'allowed' : 'denied';
  } else if (isError) {
    status = 'error';
  } else if (isPending) {
    // Covers an offline-paused cold launch: pending with no data yet.
    status = 'loading';
  }
  // Any other unresolved combination keeps the initial 'loading'.

  return {
    canManage,
    status,
    isLoading,
    isError,
    isFetching,
    refetch,
    fetchStatus,
  };
}

// Reuses listFindings (status: 'open', limit 1) instead of a dedicated
// procedure — the concurrency numbers ride along on every findings fetch.
// `isLoading`/`isError` are exposed alongside the counts so callers can tell
// "still loading" and "failed to load" apart from "loaded: capacity full" —
// all three previously collapsed into the same undefined counts.
export function useSecurityAnalysisCapacity(scope: string) {
  const trpc = useTRPC();
  const capacityInput = { status: 'open' as const, limit: 1, offset: 0 };
  const personal = useQuery({
    ...trpc.securityAgent.listFindings.queryOptions(capacityInput),
    enabled: isPersonalSecurityScope(scope),
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.listFindings.queryOptions({
      organizationId: scope,
      ...capacityInput,
    }),
    enabled: !isPersonalSecurityScope(scope),
  });
  const active = isPersonalSecurityScope(scope) ? personal : organization;
  return {
    runningCount: active.data?.runningCount,
    concurrencyLimit: active.data?.concurrencyLimit,
    isLoading: active.isLoading,
    isError: active.isError,
    refetch: active.refetch,
  };
}
