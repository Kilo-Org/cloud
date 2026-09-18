import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc';

export type {
  AgentProfileDetail,
  AgentProfileListCombined,
  AgentProfileListItem,
} from '@/lib/hooks/agent-profile-types';
export { useAgentProfileMutations } from '@/lib/hooks/use-agent-profile-mutations';
export { useAgentProfileSectionMutations } from '@/lib/hooks/use-agent-profile-section-mutations';

/**
 * List the profiles for a context. Personal context reads `list`; org context
 * reads `listCombined`, which groups org and personal profiles and already
 * resolves `effectiveDefaultId` (personal default > org default).
 *
 * `placeholderData: keepPreviousData` keeps the previous rows across a refetch,
 * so the list never blanks while a refetch is in flight.
 *
 * `isLoading` is `isPending`, not React Query's `isLoading`: in v5 `isLoading`
 * is `isPending && isFetching`, which is false while a paused (offline) first
 * fetch is unsettled. `isPending` stays true until the query settles, so the
 * screen cannot mistake an unloaded list for an empty one.
 */
export function useAgentProfileList(organizationId?: string) {
  const trpc = useTRPC();
  const isOrganization = organizationId !== undefined;

  const personal = useQuery({
    ...trpc.agentProfiles.list.queryOptions({}),
    enabled: !isOrganization,
    placeholderData: keepPreviousData,
  });
  const combined = useQuery({
    ...trpc.agentProfiles.listCombined.queryOptions({ organizationId: organizationId ?? '' }),
    enabled: isOrganization,
    placeholderData: keepPreviousData,
  });

  const query = isOrganization ? combined : personal;

  return {
    orgProfiles: isOrganization ? (combined.data?.orgProfiles ?? []) : [],
    personalProfiles: isOrganization
      ? (combined.data?.personalProfiles ?? [])
      : (personal.data ?? []),
    effectiveDefaultId: isOrganization
      ? (combined.data?.effectiveDefaultId ?? null)
      : (personal.data?.find(profile => profile.isDefault)?.id ?? null),
    isLoading: query.isPending,
    isError: query.isError,
    isRefetching: query.isRefetching,
    refetch: query.refetch,
  };
}

/** A single profile with its variables, commands, MCP servers, skills and agents. */
export function useAgentProfile(profileId: string, organizationId?: string) {
  const trpc = useTRPC();
  return useQuery(trpc.agentProfiles.get.queryOptions({ profileId, organizationId }));
}
