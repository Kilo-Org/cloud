import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useTRPC } from '@/lib/trpc';

type ProfileSummary = inferRouterOutputs<MobileRouter>['agentProfiles']['list'][number];
type CombinedProfiles = inferRouterOutputs<MobileRouter>['agentProfiles']['listCombined'];

/** The read-only capability view the new-session form renders. */
export type EffectiveAgentProfile = {
  id: string;
  name: string;
  commandCount: number;
  mcpServerCount: number;
  skillCount: number;
  agentCount: number;
};

function toEffective(profile: ProfileSummary): EffectiveAgentProfile {
  return {
    id: profile.id,
    name: profile.name,
    commandCount: profile.commandCount,
    mcpServerCount: profile.mcpServerCount,
    skillCount: profile.skillCount,
    agentCount: profile.agentCount,
  };
}

/**
 * Resolve the personal default from a `list` result: the first profile marked
 * `isDefault`, else none.
 */
export function resolvePersonalDefault(profiles: ProfileSummary[]): ProfileSummary | null {
  return profiles.find(profile => profile.isDefault) ?? null;
}

/**
 * Resolve the effective profile from a `listCombined` result. The server has
 * already applied "personal default > org default"; `effectiveDefaultId` names
 * the winner, and this locates its summary in either bucket.
 */
export function resolveCombinedDefault(combined: CombinedProfiles): ProfileSummary | null {
  if (combined.effectiveDefaultId === null) {
    return null;
  }
  return (
    combined.personalProfiles.find(profile => profile.id === combined.effectiveDefaultId) ??
    combined.orgProfiles.find(profile => profile.id === combined.effectiveDefaultId) ??
    null
  );
}

/**
 * Query the current context's agent profiles and resolve the effective default
 * profile. Personal context reads `agentProfiles.list`; org context reads
 * `agentProfiles.listCombined` (whose `effectiveDefaultId` already encodes
 * "personal default > org default > none").
 */
export function useEffectiveAgentProfile(organizationId?: string) {
  const trpc = useTRPC();

  const personal = useQuery({
    ...trpc.agentProfiles.list.queryOptions({}),
    enabled: organizationId === undefined,
  });

  const combined = useQuery({
    ...trpc.agentProfiles.listCombined.queryOptions({ organizationId: organizationId ?? '' }),
    enabled: organizationId !== undefined,
  });

  const isOrg = organizationId !== undefined;
  const query = isOrg ? combined : personal;

  const profile = useMemo(() => {
    // A failed profile query must not leak a cached profile into the form:
    // the error row is shown and Start submits with no effective profile id.
    if (query.isError) {
      return null;
    }
    if (isOrg) {
      const resolved = combined.data ? resolveCombinedDefault(combined.data) : null;
      return resolved ? toEffective(resolved) : null;
    }
    const resolved = personal.data ? resolvePersonalDefault(personal.data) : null;
    return resolved ? toEffective(resolved) : null;
  }, [isOrg, personal.data, combined.data, query.isError]);

  return {
    profile,
    profileId: profile?.id ?? null,
    // Gate on `isPending`, not `isLoading`: in React Query v5 `isLoading` is
    // `isPending && isFetching`, so a paused (offline) first fetch has
    // `isLoading: false` while still unsettled. `isPending` stays true until
    // the query settles (success or error), so Start stays blocked and
    // `profileId` stays unset only after a settled empty or error result.
    isLoading: query.isPending,
    isError: query.isError,
    refetch: query.refetch,
  };
}
