import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import {
  keepPreviousData,
  type MutationOptions,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner-native';

import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { useTRPC } from '@/lib/trpc';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

/** A profile summary as the list surfaces render it. Org summaries add `ownerType`. */
export type AgentProfileListItem = RouterOutputs['agentProfiles']['list'][number] & {
  ownerType?: 'organization' | 'user';
};

export type AgentProfileListCombined = RouterOutputs['agentProfiles']['listCombined'];
export type AgentProfileDetail = RouterOutputs['agentProfiles']['get'];

// Optimistic writes on the same cache region are generation-stamped so an older
// mutation's rollback cannot stomp a newer mutation's optimistic value.
const DEFAULT_MUTATION_KEY = 'agentProfiles:default';
const SKILL_MUTATION_KEY = 'agentProfiles:skill';

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

/**
 * Add the hook's context organization to a mutation's input, so every screen
 * under the same context does not repeat `organizationId` at each call site.
 * `organizationId` is optional in every `agentProfiles.*` input, so the merged
 * object is still the procedure's input type.
 */
function withOrganization<TData, TError, TVariables extends { organizationId?: string }, TContext>(
  options: MutationOptions<TData, TError, TVariables, TContext>,
  organizationId: string | undefined
): MutationOptions<TData, TError, TVariables, TContext> {
  const mutationFn = options.mutationFn;
  if (!mutationFn || organizationId === undefined) {
    return options;
  }
  return {
    ...options,
    // The wrapper must return the underlying promise unchanged; `async` without
    // an await trips `require-await` (same conflict noted in use-code-reviewer).
    // eslint-disable-next-line typescript-eslint/promise-function-async -- wraps a promise-returning mutationFn
    mutationFn: (variables, context) => mutationFn({ ...variables, organizationId }, context),
  };
}

function withDefaultFlag<T extends { id: string; isDefault: boolean }>(
  profiles: readonly T[],
  defaultId: string | null
): T[] {
  return profiles.map(profile => {
    const isDefault = profile.id === defaultId;
    return profile.isDefault === isDefault ? profile : { ...profile, isDefault };
  });
}

function withDefaultDetail(
  profile: AgentProfileDetail,
  defaultId: string | null
): AgentProfileDetail {
  const isDefault = profile.id === defaultId;
  return profile.isDefault === isDefault ? profile : { ...profile, isDefault };
}

function withSkillEnabled(
  profile: AgentProfileDetail,
  skillId: string,
  enabled: boolean
): AgentProfileDetail {
  return {
    ...profile,
    skills: profile.skills.map(skill => (skill.id === skillId ? { ...skill, enabled } : skill)),
  };
}

/**
 * Every mutation the profile-management screens call. Each mutation carries the
 * hook's organization context, toasts a failed server call exactly once, and
 * invalidates the `agentProfiles` namespace so the list and detail queries
 * reconcile with server truth.
 *
 * `setAsDefault`, `clearDefault` and `setSkillEnabled` are optimistic: they
 * snapshot the affected cache in `onMutate`, roll back in `onError` (latest
 * generation only), and invalidate again in `onSettled` to reconcile.
 */
export function useAgentProfileMutations(organizationId?: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const profilesFilter = trpc.agentProfiles.pathFilter();
  const listFilter = trpc.agentProfiles.list.pathFilter();
  const combinedFilter = trpc.agentProfiles.listCombined.pathFilter();
  const detailFilter = trpc.agentProfiles.get.pathFilter();

  const invalidateProfiles = () => {
    void queryClient.invalidateQueries(profilesFilter);
  };
  const toastError = (error: { message: string }) => {
    toast.error(error.message);
  };
  const callbacks = {
    onSuccess: invalidateProfiles,
    onError: (error: { message: string }) => {
      toastError(error);
    },
  };

  const applyDefault = (defaultId: string | null) => {
    queryClient.setQueriesData<AgentProfileListItem[]>({ queryKey: listFilter.queryKey }, old =>
      old ? withDefaultFlag(old, defaultId) : old
    );
    queryClient.setQueriesData<AgentProfileListCombined>(
      { queryKey: combinedFilter.queryKey },
      old =>
        old
          ? {
              orgProfiles: withDefaultFlag(old.orgProfiles, defaultId),
              personalProfiles: withDefaultFlag(old.personalProfiles, defaultId),
              effectiveDefaultId: defaultId,
            }
          : old
    );
    queryClient.setQueriesData<AgentProfileDetail>({ queryKey: detailFilter.queryKey }, old =>
      old ? withDefaultDetail(old, defaultId) : old
    );
  };

  const snapshotProfiles = async () => {
    await queryClient.cancelQueries({ queryKey: listFilter.queryKey });
    await queryClient.cancelQueries({ queryKey: combinedFilter.queryKey });
    await queryClient.cancelQueries({ queryKey: detailFilter.queryKey });
    const previous: [QueryKey, unknown][] = [
      ...queryClient.getQueriesData<AgentProfileListItem[]>({ queryKey: listFilter.queryKey }),
      ...queryClient.getQueriesData<AgentProfileListCombined>({
        queryKey: combinedFilter.queryKey,
      }),
      ...queryClient.getQueriesData<AgentProfileDetail>({ queryKey: detailFilter.queryKey }),
    ];
    return { generation: nextMutationGeneration(DEFAULT_MUTATION_KEY), previous };
  };

  const rollbackProfiles = (
    context: { generation: number; previous: [QueryKey, unknown][] } | undefined
  ) => {
    if (!context || !isLatestMutationGeneration(DEFAULT_MUTATION_KEY, context.generation)) {
      return;
    }
    for (const [key, data] of context.previous) {
      queryClient.setQueryData(key, data);
    }
  };

  const create = useMutation(
    withOrganization(trpc.agentProfiles.create.mutationOptions(callbacks), organizationId)
  );
  const update = useMutation(
    withOrganization(trpc.agentProfiles.update.mutationOptions(callbacks), organizationId)
  );
  const deleteProfile = useMutation(
    withOrganization(trpc.agentProfiles.delete.mutationOptions(callbacks), organizationId)
  );
  const setVar = useMutation(
    withOrganization(trpc.agentProfiles.setVar.mutationOptions(callbacks), organizationId)
  );
  const deleteVar = useMutation(
    withOrganization(trpc.agentProfiles.deleteVar.mutationOptions(callbacks), organizationId)
  );
  const setCommands = useMutation(
    withOrganization(trpc.agentProfiles.setCommands.mutationOptions(callbacks), organizationId)
  );
  const createCustomSkill = useMutation(
    withOrganization(
      trpc.agentProfiles.createCustomSkill.mutationOptions(callbacks),
      organizationId
    )
  );
  const updateSkill = useMutation(
    withOrganization(trpc.agentProfiles.updateSkill.mutationOptions(callbacks), organizationId)
  );
  const deleteSkill = useMutation(
    withOrganization(trpc.agentProfiles.deleteSkill.mutationOptions(callbacks), organizationId)
  );

  const setAsDefault = useMutation(
    withOrganization(
      trpc.agentProfiles.setAsDefault.mutationOptions({
        ...callbacks,
        onMutate: async variables => {
          const context = await snapshotProfiles();
          applyDefault(variables.profileId);
          return context;
        },
        onError: (error, _variables, context) => {
          rollbackProfiles(context);
          toastError(error);
        },
        onSettled: invalidateProfiles,
      }),
      organizationId
    )
  );

  const clearDefault = useMutation(
    withOrganization(
      trpc.agentProfiles.clearDefault.mutationOptions({
        ...callbacks,
        onMutate: async () => {
          const context = await snapshotProfiles();
          applyDefault(null);
          return context;
        },
        onError: (error, _variables, context) => {
          rollbackProfiles(context);
          toastError(error);
        },
        onSettled: invalidateProfiles,
      }),
      organizationId
    )
  );

  const setSkillEnabled = useMutation(
    withOrganization(
      trpc.agentProfiles.setSkillEnabled.mutationOptions({
        ...callbacks,
        onMutate: async variables => {
          await queryClient.cancelQueries({ queryKey: detailFilter.queryKey });
          const generation = nextMutationGeneration(SKILL_MUTATION_KEY);
          const previous = queryClient.getQueriesData<AgentProfileDetail>({
            queryKey: detailFilter.queryKey,
          });
          queryClient.setQueriesData<AgentProfileDetail>({ queryKey: detailFilter.queryKey }, old =>
            old ? withSkillEnabled(old, variables.skillId, variables.enabled) : old
          );
          return { generation, previous };
        },
        onError: (error, _variables, context) => {
          if (context && isLatestMutationGeneration(SKILL_MUTATION_KEY, context.generation)) {
            for (const [key, data] of context.previous) {
              queryClient.setQueryData(key, data);
            }
          }
          toastError(error);
        },
        onSettled: invalidateProfiles,
      }),
      organizationId
    )
  );

  return {
    create,
    update,
    deleteProfile,
    setAsDefault,
    clearDefault,
    setVar,
    deleteVar,
    setCommands,
    createCustomSkill,
    updateSkill,
    deleteSkill,
    setSkillEnabled,
  };
}
