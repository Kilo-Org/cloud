import {
  canManageSecurityAgent,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

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
    };
  }
  return {
    role: query.data?.find(org => org.organizationId === scope)?.role,
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching: query.isFetching,
    refetch: query.refetch,
  };
}

// Discriminated capability state for consumers (e.g. audit-report access)
// that must distinguish "still loading"/"failed to load" from "resolved:
// no access" instead of treating an undefined role as permission-denied.
export function useSecurityAgentCapability(scope: string): {
  canManage: boolean;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => unknown;
} {
  const { role, isLoading, isError, isFetching, refetch } = useSecurityAgentOrgRoleQuery(scope);
  return {
    canManage: canManageSecurityAgent(scope, role),
    isLoading,
    isError,
    isFetching,
    refetch,
  };
}

// Reuses listFindings (status: 'open', limit 1) instead of a dedicated
// procedure — the concurrency numbers ride along on every findings fetch.
// `isLoading`/`isError` are exposed alongside the counts so callers can tell
// "still loading" and "failed to load" apart from "loaded: capacity full" —
// all three previously collapsed into the same undefined counts.
export function useSecurityAnalysisCapacity(scope: string): {
  runningCount: number | undefined;
  concurrencyLimit: number | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => unknown;
} {
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
