import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { splitProfilesByOwner } from '@/components/profiles/profile-owner-model';
import {
  type AgentProfileDetail,
  type AgentProfileListItem,
} from '@/lib/hooks/agent-profile-types';
import { useTRPC } from '@/lib/trpc';

export type { AgentProfileDetail, AgentProfileListItem };
export { useAgentProfileMutations } from '@/lib/hooks/use-agent-profile-mutations';
export { useAgentProfileSectionMutations } from '@/lib/hooks/use-agent-profile-section-mutations';

/**
 * Keep the previous rows across a refetch of the SAME query key. React Query's
 * `keepPreviousData` also keeps them across a query-key change, so switching
 * organization would render the previous organization's rows while the
 * actions already use the newly selected scope. Comparing the previous query's
 * key to the current one drops the placeholder the moment the input changes and
 * still keeps the rows across a same-input refetch.
 *
 * Exported so every context-scoped list hook shares the guard; `useRepoBindings`
 * has the same organization switch to survive.
 */
export function keepPreviousDataForQueryKey<TQueryData>(
  queryKey: readonly unknown[]
): (
  previousData: TQueryData | undefined,
  previousQuery: { queryKey: readonly unknown[] } | undefined
) => TQueryData | undefined {
  const currentKey = JSON.stringify(queryKey);
  return (previousData, previousQuery) =>
    previousQuery !== undefined && JSON.stringify(previousQuery.queryKey) === currentKey
      ? previousData
      : undefined;
}

/**
 * List the profiles for a context. Personal context reads `list`; org context
 * reads `listCombined`, which groups org and personal profiles and already
 * resolves `effectiveDefaultId` (personal default > org default).
 *
 * `placeholderData` keeps the previous rows across a refetch of the same key,
 * so the list never blanks while a refetch is in flight; a different key (an
 * organization switch) starts empty instead of showing another scope's rows.
 *
 * `isLoading` is `isPending`, not React Query's `isLoading`: in v5 `isLoading`
 * is `isPending && isFetching`, which is false while a paused (offline) first
 * fetch is unsettled. `isPending` stays true until the query settles, so the
 * screen cannot mistake an unloaded list for an empty one.
 */
export function useAgentProfileList(organizationId?: string) {
  const trpc = useTRPC();
  const isOrganization = organizationId !== undefined;

  const personalOptions = trpc.agentProfiles.list.queryOptions({});
  const combinedOptions = trpc.agentProfiles.listCombined.queryOptions({
    organizationId: organizationId ?? '',
  });

  const personal = useQuery({
    ...personalOptions,
    enabled: !isOrganization,
    placeholderData: keepPreviousDataForQueryKey(personalOptions.queryKey),
  });
  const combined = useQuery({
    ...combinedOptions,
    enabled: isOrganization,
    placeholderData: keepPreviousDataForQueryKey(combinedOptions.queryKey),
  });

  const query = isOrganization ? combined : personal;
  // The bucket split lives in the pure ownership model, so the org/personal
  // rule has one source of truth (`ProfilesListDialog.tsx:95-100`). Memoized on
  // the query data: consumers memoize on the bucket identity, so a render that
  // did not change the data must not mint new arrays.
  const { orgProfiles, personalProfiles } = useMemo(
    () =>
      splitProfilesByOwner<AgentProfileListItem>({
        isOrgContext: isOrganization,
        combined: combined.data,
        personal: personal.data,
      }),
    [isOrganization, combined.data, personal.data]
  );

  return {
    orgProfiles,
    personalProfiles,
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
