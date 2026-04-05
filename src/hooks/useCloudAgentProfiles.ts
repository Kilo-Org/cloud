/** React Query hooks for managing cloud agent environment profiles. */
'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

export type ProfileDetails = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  vars: ProfileVar[];
  commands: ProfileCommand[];
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
        await invalidateProfiles();
      },
    })
  );

  const clearDefault = useMutation(
    trpc.agentProfiles.clearDefault.mutationOptions({
      onSuccess: async () => {
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

  return {
    createProfile,
    updateProfile,
    deleteProfile,
    setAsDefault,
    clearDefault,
    setVar,
    deleteVar,
    setCommands,
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
 * Org default takes precedence over personal default.
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
        await invalidateCombinedProfiles();
      },
    })
  );

  const clearDefault = useMutation(
    trpc.agentProfiles.clearDefault.mutationOptions({
      onSuccess: async () => {
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

  return {
    createProfile,
    updateProfile,
    deleteProfile,
    setAsDefault,
    clearDefault,
    setVar,
    deleteVar,
    setCommands,
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
