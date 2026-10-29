'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { EnvironmentRepository } from '@/hooks/useCloudAgentEnvironments';

export type EnvironmentRepositoryChoice = {
  platform: EnvironmentRepository['platform'];
  label: string;
  repository: EnvironmentRepository;
};

/** The repositories the owner can put in an environment: every connected platform's list. */
export function useEnvironmentRepositoryChoices(
  organizationId: string | undefined
): EnvironmentRepositoryChoice[] {
  const trpc = useTRPC();
  const { data: githubRepoData } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({ forceRefresh: false })
  );
  const { data: gitlabRepoData } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitLabRepositories.queryOptions({ forceRefresh: false })
  );
  const { data: bitbucketRepoData } = useQuery({
    ...trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryOptions({
      organizationId: organizationId ?? '',
      forceRefresh: false,
    }),
    enabled: !!organizationId,
  });

  return useMemo(() => {
    const github = (githubRepoData?.repositories ?? []).map(repo => ({
      platform: 'github' as const,
      label: repo.fullName,
      repository: { platform: 'github' as const, fullName: repo.fullName },
    }));
    const gitlab = (gitlabRepoData?.repositories ?? []).map(repo => ({
      platform: 'gitlab' as const,
      label: repo.fullName,
      repository: { platform: 'gitlab' as const, projectPath: repo.fullName },
    }));
    const bitbucket = (
      bitbucketRepoData?.status === 'available' ? bitbucketRepoData.repositories : []
    ).map(repo => ({
      platform: 'bitbucket' as const,
      label: repo.fullName,
      repository: {
        platform: 'bitbucket' as const,
        fullName: repo.fullName,
        workspaceUuid: repo.workspaceUuid,
        repositoryUuid: String(repo.id),
      },
    }));
    return [...github, ...gitlab, ...bitbucket];
  }, [githubRepoData, gitlabRepoData, bitbucketRepoData]);
}
