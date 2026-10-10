/** React Query hooks for managing cloud agent repository environments. */
'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EnvironmentResponse,
  EnvironmentSecretChange,
  EnvironmentSummary,
} from '@kilocode/cloud-agent-profile';
import { useTRPC } from '@/lib/trpc/utils';

export type { EnvironmentResponse, EnvironmentSecretChange, EnvironmentSummary };

/** The selected repository, in the shape the picker and dialog need. */
export type EnvironmentRepository =
  | { platform: 'github'; fullName: string }
  | { platform: 'gitlab'; projectPath: string }
  | { platform: 'bitbucket'; fullName: string; workspaceUuid: string; repositoryUuid: string };

type EnvironmentListRepository =
  | { platform: 'github'; fullName: string }
  | { platform: 'gitlab'; projectPath: string }
  | { platform: 'bitbucket'; workspaceUuid: string; repositoryUuid: string };

function toListRepository(repository: EnvironmentRepository): EnvironmentListRepository {
  switch (repository.platform) {
    case 'github':
      return { platform: 'github', fullName: repository.fullName };
    case 'gitlab':
      return { platform: 'gitlab', projectPath: repository.projectPath };
    case 'bitbucket':
      return {
        platform: 'bitbucket',
        workspaceUuid: repository.workspaceUuid,
        repositoryUuid: repository.repositoryUuid,
      };
  }
}

// Never fetched: the query is disabled until a repository is selected.
const NO_REPOSITORY: EnvironmentListRepository = { platform: 'github', fullName: '' };

type UseEnvironmentsOptions = {
  organizationId?: string;
  repository: EnvironmentRepository | undefined;
  enabled?: boolean;
};

export function useCloudAgentEnvironments(options: UseEnvironmentsOptions) {
  const { organizationId, repository, enabled = true } = options;
  const trpc = useTRPC();

  return useQuery(
    trpc.cloudEnvironments.list.queryOptions(
      {
        organizationId,
        repository: repository ? toListRepository(repository) : NO_REPOSITORY,
      },
      {
        enabled: enabled && !!repository,
        staleTime: 30_000,
      }
    )
  );
}

type UseEnvironmentOptions = {
  organizationId?: string;
  enabled?: boolean;
};

/** Every environment for the owner, across repositories (settings view). */
export function useCloudAgentEnvironmentsForOwner(options: UseEnvironmentOptions) {
  const trpc = useTRPC();
  const { organizationId, enabled = true } = options;

  return useQuery(
    trpc.cloudEnvironments.listAll.queryOptions({ organizationId }, { enabled, staleTime: 30_000 })
  );
}

export function useCloudAgentEnvironment(
  environmentId: string | null,
  options: UseEnvironmentOptions = {}
) {
  const { organizationId, enabled = true } = options;
  const trpc = useTRPC();

  return useQuery(
    trpc.cloudEnvironments.get.queryOptions(
      { organizationId, environmentId: environmentId ?? '' },
      {
        enabled: enabled && !!environmentId,
        staleTime: 30_000,
      }
    )
  );
}

export function useCloudAgentEnvironmentMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.cloudEnvironments.list.queryKey() });
    await queryClient.invalidateQueries({ queryKey: trpc.cloudEnvironments.listAll.queryKey() });
    await queryClient.invalidateQueries({ queryKey: trpc.cloudEnvironments.get.queryKey() });
  };

  const createEnvironment = useMutation(
    trpc.cloudEnvironments.create.mutationOptions({ onSuccess: invalidate })
  );
  const updateEnvironment = useMutation(
    trpc.cloudEnvironments.update.mutationOptions({ onSuccess: invalidate })
  );
  const deleteEnvironment = useMutation(
    trpc.cloudEnvironments.delete.mutationOptions({ onSuccess: invalidate })
  );

  return { createEnvironment, updateEnvironment, deleteEnvironment };
}
