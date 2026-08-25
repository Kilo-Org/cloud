import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  type RepositorySectionView,
  resolveRepositorySectionView,
} from '@/components/agents/new-session-repository-state';
import { useGitHubReposRefresh } from '@/lib/use-github-repos-refresh';
import { getRepoOptionKey, type RepoOption } from '@/lib/picker-bridge';
import { useTRPC } from '@/lib/trpc';

type UseNewSessionReposArgs = {
  organizationId: string | undefined;
};

type UseNewSessionReposResult = {
  repositories: RepoOption[];
  view: RepositorySectionView;
  isRetrying: boolean;
  openGitHubIntegration: () => void;
  refreshReposForceFresh: () => Promise<void>;
};

export function useNewSessionRepos({
  organizationId,
}: UseNewSessionReposArgs): UseNewSessionReposResult {
  const trpc = useTRPC();
  const {
    data: repoData,
    isLoading: isLoadingRepos,
    isError: isReposError,
    isRefetching: isRefetchingRepos,
  } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  const { openGitHubIntegration, refreshReposForceFresh, isRefreshingRepos, connectCheckFailed } =
    useGitHubReposRefresh({
      organizationId,
      integrationInstalled: repoData?.integrationInstalled,
    });

  const view = resolveRepositorySectionView({
    isLoading: isLoadingRepos,
    isError: isReposError,
    integrationInstalled: repoData?.integrationInstalled,
    repositoryCount: repoData?.repositories.length ?? 0,
    connectCheckFailed,
  });

  const isRetrying = isRefetchingRepos || isRefreshingRepos;

  const repositories = useMemo(() => {
    if (!repoData?.repositories) {
      return [];
    }
    return repoData.repositories.map(r => {
      // Optional while older API deployments remain reachable.
      const repository = r as typeof r & {
        platformIntegrationId?: string;
        platformAccountLogin?: string;
      };
      return {
        key: getRepoOptionKey(repository),
        fullName: repository.fullName,
        isPrivate: repository.private,
        ...(repository.platformIntegrationId
          ? { platformIntegrationId: repository.platformIntegrationId }
          : {}),
        ...(repository.platformAccountLogin
          ? { platformAccountLogin: repository.platformAccountLogin }
          : {}),
      };
    });
  }, [repoData]);

  return { repositories, view, isRetrying, openGitHubIntegration, refreshReposForceFresh };
}
