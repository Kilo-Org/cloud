import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { withOrganization } from '@/lib/hooks/agent-profile-mutation-helpers';
import {
  type AgentProfileDetail,
  type AgentProfileListCombined,
  type AgentProfileListItem,
} from '@/lib/hooks/agent-profile-types';
import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { useTRPC } from '@/lib/trpc';

// Optimistic writes on the same cache region are generation-stamped so an older
// mutation's rollback cannot stomp a newer mutation's optimistic value.
const DEFAULT_MUTATION_KEY = 'agentProfiles:default';
const SKILL_MUTATION_KEY = 'agentProfiles:skill';

function withDefaultFlag<T extends { id: string; isDefault: boolean }>(
  profiles: readonly T[],
  profileId: string,
  setDefault: boolean
): T[] {
  return profiles.map(profile => withDefaultDetail(profile, profileId, setDefault));
}

function withDefaultDetail<T extends { id: string; isDefault: boolean }>(
  profile: T,
  profileId: string,
  setDefault: boolean
): T {
  const isDefault = setDefault
    ? profile.id === profileId
    : profile.id !== profileId && profile.isDefault;
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
 * Every mutation the profile-management screens call for the profile itself, its
 * variables, setup commands, and skills. Each mutation carries the hook's
 * organization context, toasts a failed server call exactly once, and
 * invalidates the `agentProfiles` namespace so the list and detail queries
 * reconcile with server truth.
 *
 * The section editors (MCP servers, agents, kilo commands) have their own hook
 * in `use-agent-profile-section-mutations`.
 *
 * `setAsDefault`, `clearDefault` and `setSkillEnabled` are optimistic: they
 * snapshot the affected cache in `onMutate`, roll back in `onError` (latest
 * generation only), and invalidate again in `onSettled` to reconcile.
 */
export function useAgentProfileMutations(organizationId?: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const profilesFilter = trpc.agentProfiles.pathFilter();
  const combinedFilter = trpc.agentProfiles.listCombined.pathFilter();
  const detailFilter = trpc.agentProfiles.get.pathFilter();
  const defaultListKey = trpc.agentProfiles.list.queryKey({ organizationId });
  const defaultDetailKey = trpc.agentProfiles.get.queryKey({ organizationId });
  const defaultCombinedKey = organizationId
    ? trpc.agentProfiles.listCombined.queryKey({ organizationId })
    : combinedFilter.queryKey;

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

  const applyDefault = (profileId: string, setDefault: boolean) => {
    queryClient.setQueriesData<AgentProfileListItem[]>({ queryKey: defaultListKey }, old =>
      old ? withDefaultFlag(old, profileId, setDefault) : old
    );
    queryClient.setQueriesData<AgentProfileListCombined>({ queryKey: defaultCombinedKey }, old => {
      if (!old) {
        return old;
      }
      const orgProfiles = organizationId
        ? withDefaultFlag(old.orgProfiles, profileId, setDefault)
        : old.orgProfiles;
      const personalProfiles = organizationId
        ? old.personalProfiles
        : withDefaultFlag(old.personalProfiles, profileId, setDefault);
      return {
        ...old,
        orgProfiles,
        personalProfiles,
        effectiveDefaultId:
          (
            personalProfiles.find(profile => profile.isDefault) ??
            orgProfiles.find(profile => profile.isDefault)
          )?.id ?? null,
      };
    });
    queryClient.setQueriesData<AgentProfileDetail>({ queryKey: defaultDetailKey }, old =>
      old ? withDefaultDetail(old, profileId, setDefault) : old
    );
  };

  const snapshotProfiles = async () => {
    await queryClient.cancelQueries({ queryKey: defaultListKey });
    await queryClient.cancelQueries({ queryKey: defaultCombinedKey });
    await queryClient.cancelQueries({ queryKey: defaultDetailKey });
    const previous: [QueryKey, unknown][] = [
      ...queryClient.getQueriesData<AgentProfileListItem[]>({ queryKey: defaultListKey }),
      ...queryClient.getQueriesData<AgentProfileListCombined>({
        queryKey: defaultCombinedKey,
      }),
      ...queryClient.getQueriesData<AgentProfileDetail>({ queryKey: defaultDetailKey }),
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
          applyDefault(variables.profileId, true);
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
        onMutate: async variables => {
          const context = await snapshotProfiles();
          applyDefault(variables.profileId, false);
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
