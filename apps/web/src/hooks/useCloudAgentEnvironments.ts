/** React Query hooks for managing cloud agent repository environments. */
'use client';

import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EnvironmentPlatform,
  EnvironmentResponse,
  EnvironmentSecretChange,
  EnvironmentSummary,
} from '@kilocode/cloud-agent-profile';
import { useTRPC } from '@/lib/trpc/utils';

export type { EnvironmentResponse, EnvironmentSecretChange, EnvironmentSummary };

/** One repository of an environment, as the settings UI shows it. */
export type EnvironmentMemberResponse = {
  platform: EnvironmentPlatform;
  repoFullName: string;
  gitlabCloneUrl: string | null;
  bitbucketWorkspaceUuid: string | null;
  bitbucketRepositoryUuid: string | null;
};

/**
 * The repositories of an environment: the V2 list, or the V1 identity as one
 * repository. A stored environment always has at least one.
 */
export function environmentMembers(
  environment: EnvironmentSummary | EnvironmentResponse
): EnvironmentMemberResponse[] {
  if (environment.repositories !== undefined) {
    return environment.repositories.map(entry => ({
      platform: entry.platform,
      repoFullName: entry.repoFullName,
      gitlabCloneUrl: entry.platform === 'gitlab' ? entry.gitlabCloneUrl : null,
      bitbucketWorkspaceUuid: entry.platform === 'bitbucket' ? entry.bitbucketWorkspaceUuid : null,
      bitbucketRepositoryUuid:
        entry.platform === 'bitbucket' ? entry.bitbucketRepositoryUuid : null,
    }));
  }
  return [
    {
      platform: environment.platform,
      repoFullName: environment.repoFullName,
      gitlabCloneUrl: environment.gitlabCloneUrl,
      bitbucketWorkspaceUuid: environment.bitbucketWorkspaceUuid,
      bitbucketRepositoryUuid: environment.bitbucketRepositoryUuid,
    },
  ];
}

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

/**
 * The environments that match the selected repository. `matches` is undefined
 * while loading and after a failed load; `isLoading` tells them apart. The same
 * repository may match several environments.
 */
export function useRepositoryEnvironments(options: UseEnvironmentsOptions): {
  matches: EnvironmentSummary[] | undefined;
  isLoading: boolean;
} {
  const { data, isLoading } = useCloudAgentEnvironments(options);
  return { matches: data, isLoading };
}

type UseEnvironmentOptions = {
  organizationId?: string;
  enabled?: boolean;
};

/**
 * Whether the owner can create multi-repository environments. The server
 * evaluates the flag for the owner, so the answer matches what it accepts.
 */
export function useMultiRepositoryEnvironmentsEnabled(organizationId?: string): {
  enabled: boolean;
  isPending: boolean;
} {
  const trpc = useTRPC();
  const { data, isPending } = useQuery(
    trpc.cloudEnvironments.multiRepositoryEnabled.queryOptions(
      { organizationId },
      { staleTime: 5 * 60_000 }
    )
  );
  return { enabled: data === true, isPending };
}

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
    // A saved change bumps the configuration revision the build detail shows.
    await queryClient.invalidateQueries({
      queryKey: trpc.cloudEnvironments.buildStatus.queryKey(),
    });
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

const BUILD_POLL_MS = 3_000;

/**
 * Snapshot build status for one environment. It polls only while `poll` is set
 * (the detail is open) and a build is active, so an idle environment costs no
 * requests.
 */
export function useEnvironmentBuildStatus(
  environmentId: string | null,
  options: UseEnvironmentOptions & { poll?: boolean } = {}
) {
  const { organizationId, enabled = true, poll = false } = options;
  const trpc = useTRPC();
  return useQuery(
    trpc.cloudEnvironments.buildStatus.queryOptions(
      { organizationId, environmentId: environmentId ?? '' },
      {
        enabled: enabled && !!environmentId,
        staleTime: 10_000,
        refetchInterval: query => (poll && query.state.data?.activeBuild ? BUILD_POLL_MS : false),
      }
    )
  );
}

/** The latest retained build output, refreshed while the build is running. */
export function useEnvironmentBuildLogs(
  environmentId: string | null,
  buildId: string | null,
  options: UseEnvironmentOptions & { live?: boolean } = {}
) {
  const { organizationId, enabled = true, live = false } = options;
  const trpc = useTRPC();
  return useQuery(
    trpc.cloudEnvironments.buildLogs.queryOptions(
      { organizationId, environmentId: environmentId ?? '', buildId: buildId ?? '' },
      {
        enabled: enabled && !!environmentId && !!buildId,
        refetchInterval: live ? BUILD_POLL_MS : false,
      }
    )
  );
}

/**
 * Build/Refresh and Cancel. A Build request keeps its request id until the
 * server answers, so a retry after a lost response cannot start a second build.
 */
export function useEnvironmentBuildMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // Survives re-renders: a retried Build after a lost response reuses its id.
  const pendingRequestIds = useRef(new Map<string, string>()).current;

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: trpc.cloudEnvironments.buildStatus.queryKey(),
    });
    await queryClient.invalidateQueries({ queryKey: trpc.cloudEnvironments.buildLogs.queryKey() });
  };

  const buildMutation = useMutation(
    trpc.cloudEnvironments.build.mutationOptions({ onSettled: invalidate })
  );
  const cancelBuild = useMutation(
    trpc.cloudEnvironments.cancelBuild.mutationOptions({ onSettled: invalidate })
  );

  const requestBuild = async (input: {
    organizationId?: string;
    environmentId: string;
    expectedRevision: number;
  }) => {
    const key = `${input.environmentId}:${input.expectedRevision}`;
    const requestId = pendingRequestIds.get(key) ?? crypto.randomUUID();
    pendingRequestIds.set(key, requestId);
    const result = await buildMutation.mutateAsync({ ...input, requestId });
    pendingRequestIds.delete(key);
    return result;
  };

  return { requestBuild, isRequesting: buildMutation.isPending, cancelBuild };
}
