/** React Query hooks for context-scoped Cloud Agent sandbox settings. */
'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

export type CloudAgentSettingsRepositoryRow = {
  repositoryFullName: string;
  repositoryPlatform: 'github' | 'gitlab';
  profileId: string | null;
  profileName: string | null;
  allocation: string | null;
  allocationUnavailableReason?: string;
  allocationRepositoryUnavailableReason?: string;
};

type UseCloudAgentSettingsOptions = {
  organizationId?: string;
  enabled?: boolean;
};

export function useCloudAgentSettings(options: UseCloudAgentSettingsOptions = {}) {
  const { organizationId, enabled = true } = options;
  const trpc = useTRPC();

  return useQuery(
    trpc.cloudAgentSettings.get.queryOptions(
      { organizationId },
      {
        enabled,
        staleTime: 30_000,
      }
    )
  );
}

export type CloudAgentSettingsData = NonNullable<ReturnType<typeof useCloudAgentSettings>['data']>;

export function useCloudAgentSettingsCanManage(options: UseCloudAgentSettingsOptions = {}) {
  const { organizationId, enabled = true } = options;
  const trpc = useTRPC();

  return useQuery(
    trpc.cloudAgentSettings.canManage.queryOptions(
      { organizationId },
      {
        enabled,
        staleTime: 30_000,
      }
    )
  );
}

function useInvalidateSettings(organizationId?: string) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.cloudAgentSettings.get.queryKey({ organizationId }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.agentProfiles.listRepoBindings.queryKey({ organizationId }),
      }),
    ]);
  };
}

export function useSetContextAllocationMutation(organizationId?: string) {
  const invalidate = useInvalidateSettings(organizationId);
  const trpc = useTRPC();

  return useMutation(
    trpc.cloudAgentSettings.setContextAllocation.mutationOptions({
      onSuccess: invalidate,
    })
  );
}

export function useSetRepositorySettingsMutation(organizationId?: string) {
  const invalidate = useInvalidateSettings(organizationId);
  const trpc = useTRPC();

  return useMutation(
    trpc.cloudAgentSettings.setRepositorySettings.mutationOptions({
      onSuccess: invalidate,
    })
  );
}

export function useRemoveRepositorySettingsMutation(organizationId?: string) {
  const invalidate = useInvalidateSettings(organizationId);
  const trpc = useTRPC();

  return useMutation(
    trpc.cloudAgentSettings.removeRepositorySettings.mutationOptions({
      onSuccess: invalidate,
    })
  );
}
