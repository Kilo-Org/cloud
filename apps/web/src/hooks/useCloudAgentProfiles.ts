/** React Query hooks for managing cloud agent environment profiles. */
'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentConfig } from '@kilocode/db/schema-types';
import { useTRPC } from '@/lib/trpc/utils';

// Owner type for profiles
export type ProfileOwnerType = 'organization' | 'user';

// Types from the tRPC router outputs
export type ProfileSummary = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  varCount: number;
  commandCount: number;
  mcpServerCount: number;
  skillCount: number;
  agentCount: number;
  kiloCommandCount: number;
};

// Profile summary with owner type for combined listings
export type ProfileSummaryWithOwner = ProfileSummary & {
  ownerType: ProfileOwnerType;
};

export type ProfileVar = {
  key: string;
  value: string;
  isSecret: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProfileCommand = {
  sequence: number;
  command: string;
};

export type ProfileMcpServer = {
  id: string;
  name: string;
  type: 'local' | 'remote';
  enabled: boolean;
  timeout: number | null;
  /** env/header values are returned masked (never plaintext/ciphertext). */
  config:
    | { command: string[]; environment?: Record<string, string> }
    | { url: string; headers?: Record<string, string> };
  createdAt: string;
  updatedAt: string;
};

export type ProfileSkill = {
  id: string;
  name: string;
  description: string | null;
  sourceType: 'marketplace' | 'custom';
  sourceUrl: string | null;
  rawMarkdown: string;
  /** Companion files (excluding SKILL.md). Relative path → content. */
  files: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProfileAgent = {
  id: string;
  slug: string;
  name: string;
  config: AgentConfig;
  createdAt: string;
  updatedAt: string;
};

export type ProfileKiloCommand = {
  id: string;
  name: string;
  description: string | null;
  template: string;
  agent: string | null;
  model: string | null;
  subtask: boolean;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ProfileDetails = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  vars: ProfileVar[];
  commands: ProfileCommand[];
  mcpServers: ProfileMcpServer[];
  skills: ProfileSkill[];
  agents: ProfileAgent[];
  kiloCommands: ProfileKiloCommand[];
};

// Combined profiles result for org context
export type CombinedProfilesResult = {
  orgProfiles: ProfileSummaryWithOwner[];
  personalProfiles: ProfileSummaryWithOwner[];
  effectiveDefaultId: string | null;
  /** Convenience: all profiles with org profiles first, then personal */
  allProfiles: ProfileSummaryWithOwner[];
};

type UseProfilesOptions = {
  organizationId?: string;
  enabled?: boolean;
};

/**
 * Hook to fetch and cache list of profiles for org or user
 */
export function useProfiles(options: UseProfilesOptions = {}) {
  const { organizationId, enabled = true } = options;
  const trpc = useTRPC();

  return useQuery(
    trpc.agentProfiles.list.queryOptions(
      { organizationId },
      {
        enabled,
        staleTime: 30_000,
      }
    )
  );
}

type UseProfileOptions = {
  organizationId?: string;
  enabled?: boolean;
};

/**
 * Hook to fetch single profile with vars and commands
 */
export function useProfile(profileId: string, options: UseProfileOptions = {}) {
  const { organizationId, enabled = true } = options;
  const trpc = useTRPC();

  return useQuery(
    trpc.agentProfiles.get.queryOptions(
      { profileId, organizationId },
      {
        enabled: enabled && !!profileId,
        staleTime: 30_000,
      }
    )
  );
}

type UseProfileMutationsOptions = {
  organizationId?: string;
};

/**
 * Hook returning all profile mutation functions
 */
export function useProfileMutations(options: UseProfileMutationsOptions = {}) {
  const { organizationId } = options;
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  const invalidateProfiles = async () => {
    await queryClient.invalidateQueries({
      queryKey: trpc.agentProfiles.list.queryKey({ organizationId }),
    });
  };

  const invalidateProfile = async (profileId: string) => {
    await queryClient.invalidateQueries({
      queryKey: trpc.agentProfiles.get.queryKey({ profileId, organizationId }),
    });
    await invalidateProfiles();
  };

  const createProfile = useMutation(
    trpc.agentProfiles.create.mutationOptions({
      onSuccess: async () => {
        await invalidateProfiles();
      },
    })
  );

  const updateProfile = useMutation(
    trpc.agentProfiles.update.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );

  const deleteProfile = useMutation(
    trpc.agentProfiles.delete.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );

  const setAsDefault = useMutation(
    trpc.agentProfiles.setAsDefault.mutationOptions({
      onSuccess: async () => {
        // Setting a default flips isDefault on both the new and previous default,
        // so invalidate every single-profile get query in addition to the list.
        await queryClient.invalidateQueries({
          queryKey: trpc.agentProfiles.get.queryKey(),
        });
        await invalidateProfiles();
      },
    })
  );

  const clearDefault = useMutation(
    trpc.agentProfiles.clearDefault.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.agentProfiles.get.queryKey(),
        });
        await invalidateProfiles();
      },
    })
  );

  const setVar = useMutation(
    trpc.agentProfiles.setVar.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );

  const deleteVar = useMutation(
    trpc.agentProfiles.deleteVar.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );

  const setCommands = useMutation(
    trpc.agentProfiles.setCommands.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );

  const createMcp = useMutation(
    trpc.agentProfiles.createMcp.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );
  const updateMcp = useMutation(
    trpc.agentProfiles.updateMcp.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );
  const deleteMcp = useMutation(
    trpc.agentProfiles.deleteMcp.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );
  const setMcpEnabled = useMutation(
    trpc.agentProfiles.setMcpEnabled.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );

  const createCustomSkill = useMutation(
    trpc.agentProfiles.createCustomSkill.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );
  const updateSkill = useMutation(
    trpc.agentProfiles.updateSkill.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );
  const deleteSkill = useMutation(
    trpc.agentProfiles.deleteSkill.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );
  const setSkillEnabled = useMutation(
    trpc.agentProfiles.setSkillEnabled.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );

  const createAgent = useMutation(
    trpc.agentProfiles.createAgent.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );
  const updateAgent = useMutation(
    trpc.agentProfiles.updateAgent.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );
  const deleteAgent = useMutation(
    trpc.agentProfiles.deleteAgent.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );

  const createKiloCommand = useMutation(
    trpc.agentProfiles.createKiloCommand.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );
  const updateKiloCommand = useMutation(
    trpc.agentProfiles.updateKiloCommand.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );
  const deleteKiloCommand = useMutation(
    trpc.agentProfiles.deleteKiloCommand.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );
  const setKiloCommandEnabled = useMutation(
    trpc.agentProfiles.setKiloCommandEnabled.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );
  const reorderKiloCommands = useMutation(
    trpc.agentProfiles.reorderKiloCommands.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId);
      },
    })
  );

  return {
    createProfile,
    updateProfile,
    deleteProfile,
    setAsDefault,
    clearDefault,
    setVar,
    deleteVar,
    setCommands,
    createMcp,
    updateMcp,
    deleteMcp,
    setMcpEnabled,
    createCustomSkill,
    updateSkill,
    deleteSkill,
    setSkillEnabled,
    createAgent,
    updateAgent,
    deleteAgent,
    createKiloCommand,
    updateKiloCommand,
    deleteKiloCommand,
    setKiloCommandEnabled,
    reorderKiloCommands,
    /** Manually invalidate profiles list */
    invalidateProfiles,
    /** Manually invalidate specific profile */
    invalidateProfile,
  };
}

/**
 * Convenience hook combining list query with mutations
 */
export function useProfilesWithMutations(options: UseProfilesOptions = {}) {
  const { organizationId, enabled = true } = options;
  const profilesQuery = useProfiles({ organizationId, enabled });
  const mutations = useProfileMutations({ organizationId });

  return {
    ...profilesQuery,
    ...mutations,
  };
}

type UseCombinedProfilesOptions = {
  organizationId: string;
  enabled?: boolean;
};

/**
 * Hook to fetch both org and personal profiles when in org context.
 * Returns profiles grouped by owner type with effective default resolution.
 * Personal default takes precedence over org default.
 */
export function useCombinedProfiles(options: UseCombinedProfilesOptions) {
  const { organizationId, enabled = true } = options;
  const trpc = useTRPC();

  return useQuery(
    trpc.agentProfiles.listCombined.queryOptions(
      { organizationId },
      {
        enabled,
        staleTime: 30_000,
        select: data => ({
          ...data,
          allProfiles: [...data.orgProfiles, ...data.personalProfiles],
        }),
      }
    )
  );
}

type UseCombinedProfileMutationsOptions = {
  organizationId: string;
};

/**
 * Hook returning profile mutation functions that work with combined profiles.
 * Invalidates both org and personal profile caches.
 */
export function useCombinedProfileMutations(options: UseCombinedProfileMutationsOptions) {
  const { organizationId } = options;
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  const invalidateCombinedProfiles = async () => {
    await queryClient.invalidateQueries({
      queryKey: trpc.agentProfiles.listCombined.queryKey({ organizationId }),
    });
    // Also invalidate individual list queries
    await queryClient.invalidateQueries({
      queryKey: trpc.agentProfiles.list.queryKey({ organizationId }),
    });
    await queryClient.invalidateQueries({
      queryKey: trpc.agentProfiles.list.queryKey({ organizationId: undefined }),
    });
  };

  const invalidateProfile = async (profileId: string, profileOrgId?: string) => {
    await queryClient.invalidateQueries({
      queryKey: trpc.agentProfiles.get.queryKey({ profileId, organizationId: profileOrgId }),
    });
    await invalidateCombinedProfiles();
  };

  const createProfile = useMutation(
    trpc.agentProfiles.create.mutationOptions({
      onSuccess: async () => {
        await invalidateCombinedProfiles();
      },
    })
  );

  const updateProfile = useMutation(
    trpc.agentProfiles.update.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );

  const deleteProfile = useMutation(
    trpc.agentProfiles.delete.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );

  const setAsDefault = useMutation(
    trpc.agentProfiles.setAsDefault.mutationOptions({
      onSuccess: async () => {
        // Setting a default flips isDefault on both the new and previous default,
        // so invalidate every single-profile get query in addition to the lists.
        await queryClient.invalidateQueries({
          queryKey: trpc.agentProfiles.get.queryKey(),
        });
        await invalidateCombinedProfiles();
      },
    })
  );

  const clearDefault = useMutation(
    trpc.agentProfiles.clearDefault.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.agentProfiles.get.queryKey(),
        });
        await invalidateCombinedProfiles();
      },
    })
  );

  const setVar = useMutation(
    trpc.agentProfiles.setVar.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );

  const deleteVar = useMutation(
    trpc.agentProfiles.deleteVar.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );

  const setCommands = useMutation(
    trpc.agentProfiles.setCommands.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );

  const createMcp = useMutation(
    trpc.agentProfiles.createMcp.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );
  const updateMcp = useMutation(
    trpc.agentProfiles.updateMcp.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );
  const deleteMcp = useMutation(
    trpc.agentProfiles.deleteMcp.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );
  const setMcpEnabled = useMutation(
    trpc.agentProfiles.setMcpEnabled.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );

  const createCustomSkill = useMutation(
    trpc.agentProfiles.createCustomSkill.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );
  const updateSkill = useMutation(
    trpc.agentProfiles.updateSkill.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );
  const deleteSkill = useMutation(
    trpc.agentProfiles.deleteSkill.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );
  const setSkillEnabled = useMutation(
    trpc.agentProfiles.setSkillEnabled.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );

  const createAgent = useMutation(
    trpc.agentProfiles.createAgent.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );
  const updateAgent = useMutation(
    trpc.agentProfiles.updateAgent.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );
  const deleteAgent = useMutation(
    trpc.agentProfiles.deleteAgent.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );

  const createKiloCommand = useMutation(
    trpc.agentProfiles.createKiloCommand.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );
  const updateKiloCommand = useMutation(
    trpc.agentProfiles.updateKiloCommand.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );
  const deleteKiloCommand = useMutation(
    trpc.agentProfiles.deleteKiloCommand.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );
  const setKiloCommandEnabled = useMutation(
    trpc.agentProfiles.setKiloCommandEnabled.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );
  const reorderKiloCommands = useMutation(
    trpc.agentProfiles.reorderKiloCommands.mutationOptions({
      onSuccess: async (_data, variables) => {
        await invalidateProfile(variables.profileId, variables.organizationId);
      },
    })
  );

  return {
    createProfile,
    updateProfile,
    deleteProfile,
    setAsDefault,
    clearDefault,
    setVar,
    deleteVar,
    setCommands,
    createMcp,
    updateMcp,
    deleteMcp,
    setMcpEnabled,
    createCustomSkill,
    updateSkill,
    deleteSkill,
    setSkillEnabled,
    createAgent,
    updateAgent,
    deleteAgent,
    createKiloCommand,
    updateKiloCommand,
    deleteKiloCommand,
    setKiloCommandEnabled,
    reorderKiloCommands,
    /** Manually invalidate combined profiles */
    invalidateCombinedProfiles,
    /** Manually invalidate specific profile */
    invalidateProfile,
  };
}

/**
 * Convenience hook combining combined profiles query with mutations.
 * Use this when in org context to get both org and personal profiles.
 */
export function useCombinedProfilesWithMutations(options: UseCombinedProfilesOptions) {
  const { organizationId, enabled = true } = options;
  const profilesQuery = useCombinedProfiles({ organizationId, enabled });
  const mutations = useCombinedProfileMutations({ organizationId });

  return {
    ...profilesQuery,
    ...mutations,
  };
}

type UseRepoBindingsOptions = {
  organizationId?: string;
  enabled?: boolean;
};

/**
 * Hook to fetch repo-profile bindings for user or organization.
 */
export function useRepoBindings(options: UseRepoBindingsOptions = {}) {
  const { organizationId, enabled = true } = options;
  const trpc = useTRPC();

  return useQuery(
    trpc.agentProfiles.listRepoBindings.queryOptions(
      { organizationId },
      { enabled, staleTime: 30_000 }
    )
  );
}

/**
 * Mutation hook to bind an environment profile to a repository.
 * Invalidates listRepoBindings and profile caches on success.
 */
export function useBindRepoMutation(organizationId?: string) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation(
    trpc.agentProfiles.bindToRepo.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.agentProfiles.listRepoBindings.queryKey({ organizationId }),
        });
        // Also invalidate profile queries to ensure UI consistency
        await queryClient.invalidateQueries({
          queryKey: trpc.agentProfiles.list.queryKey({ organizationId }),
        });
        if (organizationId) {
          await queryClient.invalidateQueries({
            queryKey: trpc.agentProfiles.listCombined.queryKey({ organizationId }),
          });
        }
      },
    })
  );
}

/**
 * Mutation hook to remove a profile binding from a repository.
 * Invalidates listRepoBindings and profile caches on success.
 */
export function useUnbindRepoMutation(organizationId?: string) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation(
    trpc.agentProfiles.unbindRepo.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.agentProfiles.listRepoBindings.queryKey({ organizationId }),
        });
        // Also invalidate profile queries to ensure UI consistency
        await queryClient.invalidateQueries({
          queryKey: trpc.agentProfiles.list.queryKey({ organizationId }),
        });
        if (organizationId) {
          await queryClient.invalidateQueries({
            queryKey: trpc.agentProfiles.listCombined.queryKey({ organizationId }),
          });
        }
      },
    })
  );
}
