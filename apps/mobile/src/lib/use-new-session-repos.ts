/* eslint-disable max-lines -- One hook wires the GitHub, GitLab, and Bitbucket provider queries, recents resolution, and connect/refresh flows end-to-end. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { repositoryResourceKey } from '@kilocode/app-shared/code-review/repository-identity';
import {
  dedupeRepositoriesByPlatformAndFullName,
  normalizeSessionRepository,
  type RepositoryGroup,
  type RepositoryGroups,
  type RepositoryPlatform,
  resolveBitbucketStatus,
  type ResolvedNewSessionRepository,
  resolveProviderStatus,
  resolveRepositoryGroups,
} from '@/components/agents/new-session-repository-state';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { readTrpcErrorField } from '@/lib/trpc-error';
import { i18n } from '@/i18n';
import { WEB_BASE_URL } from '@/lib/config';
import { useRecentAgentRepositories } from '@/lib/hooks/use-agent-sessions';
import { getBitbucketIntegrationUrl, getGitLabIntegrationUrl } from '@/lib/integration-urls';
import { openAuthorizationAndWaitForReturn } from '@/lib/pr-review/connect-gate-platform';
import { useExternalAuthReturn } from '@/lib/external-auth/use-external-auth-return';
import {
  setRepositoryDiscoveryError,
  useGitHubReposRefresh,
  withRepositoryAccount,
} from '@/lib/use-github-repos-refresh';
import { useTRPC } from '@/lib/trpc';

type UseNewSessionReposArgs = {
  organizationId: string | undefined;
};

type UseNewSessionReposResult = {
  /** Merged + deduped authorized rows (recents first) for the picker and prefill. */
  repositories: ResolvedNewSessionRepository[];
  /** Recently used rows resolved against connected providers ("Recently used" picker section). */
  recents: ResolvedNewSessionRepository[];
  groups: RepositoryGroup[];
  isRetrying: boolean;
  /** Visible requests have settled; browsing does not prove complete authorized discovery. */
  reposSettled: boolean;
  openIntegration: (platform: RepositoryPlatform) => void;
  refreshReposForceFresh: () => Promise<void>;
};

function canAutomaticallyDiscoverRepositories(error: unknown): boolean {
  const code = readTrpcErrorField(error, 'code');
  return code !== 'FORBIDDEN' && code !== 'UNAUTHORIZED';
}

export function useNewSessionRepos({
  organizationId,
}: UseNewSessionReposArgs): UseNewSessionReposResult {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { userId } = useCurrentUserId();
  const scope = useMemo(
    () => ({
      userId,
      queryClient,
      github: withRepositoryAccount(
        organizationId
          ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
              organizationId,
              forceRefresh: false,
            })
          : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({ forceRefresh: false }),
        userId
      ),
      gitlab: withRepositoryAccount(
        organizationId
          ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
              organizationId,
              forceRefresh: false,
            })
          : trpc.cloudAgentNext.listGitLabRepositories.queryOptions({ forceRefresh: false }),
        userId
      ),
      bitbucket: withRepositoryAccount(
        trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryOptions({
          organizationId: organizationId ?? '',
          forceRefresh: false,
        }),
        userId
      ),
      gitlabFresh: withRepositoryAccount(
        organizationId
          ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
              organizationId,
              forceRefresh: true,
            })
          : trpc.cloudAgentNext.listGitLabRepositories.queryOptions({ forceRefresh: true }),
        userId
      ),
      bitbucketFresh: organizationId
        ? withRepositoryAccount(
            trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryOptions({
              organizationId,
              forceRefresh: true,
            }),
            userId
          )
        : null,
    }),
    [userId, organizationId, queryClient, trpc]
  );
  const currentScope = useRef<typeof scope | null>(scope);
  currentScope.current = scope;

  // Keep normal observers active until their own error reaches the permission cache handler.
  // A denial already present at render blocks automatic discovery, including rebuilt queries.
  const githubDiscoveryAllowed = canAutomaticallyDiscoverRepositories(
    queryClient.getQueryState(scope.github.queryKey)?.error
  );
  const gitlabDiscoveryAllowed = canAutomaticallyDiscoverRepositories(
    queryClient.getQueryState(scope.gitlab.queryKey)?.error
  );
  const bitbucketDiscoveryAllowed = canAutomaticallyDiscoverRepositories(
    queryClient.getQueryState(scope.bitbucket.queryKey)?.error
  );
  // A forced success clears the current error without starting another normal fetch.
  const githubQuery = useQuery({
    ...scope.github,
    enabled: query =>
      Boolean(userId) &&
      (githubDiscoveryAllowed || canAutomaticallyDiscoverRepositories(query.state.error)),
  });
  const gitlabQuery = useQuery({
    ...scope.gitlab,
    enabled: query =>
      Boolean(userId) &&
      (gitlabDiscoveryAllowed || canAutomaticallyDiscoverRepositories(query.state.error)),
  });
  // Bitbucket is organization-only: the query is disabled without an org.
  const bitbucketQuery = useQuery({
    ...scope.bitbucket,
    enabled: query =>
      Boolean(userId && organizationId) &&
      (bitbucketDiscoveryAllowed || canAutomaticallyDiscoverRepositories(query.state.error)),
  });

  // Reconnect/refresh must also release a stale branch error, even when discovery rows are unchanged.
  useEffect(() => {
    const branches = organizationId
      ? trpc.organizations.cloudAgentNext.listRepositoryBranches
      : trpc.cloudAgentNext.listRepositoryBranches;
    void queryClient.invalidateQueries(branches.pathFilter());
  }, [
    githubQuery.dataUpdatedAt,
    gitlabQuery.dataUpdatedAt,
    bitbucketQuery.dataUpdatedAt,
    organizationId,
    queryClient,
    trpc,
  ]);

  const { data: recentRepoData } = useRecentAgentRepositories({ organizationId });

  const {
    openGitHubIntegration,
    refreshReposForceFresh: refreshGitHubForceFresh,
    isRefreshingRepos: isRefreshingGitHub,
  } = useGitHubReposRefresh({
    organizationId,
    integrationInstalled: githubQuery.data?.integrationInstalled,
  });

  const [providerRefreshCounts, setProviderRefreshCounts] = useState({ gitlab: 0, bitbucket: 0 });

  const normalize = useCallback(
    (row: Parameters<typeof normalizeSessionRepository>[0]) => {
      const repository = normalizeSessionRepository(row, userId, organizationId);
      return repository ? [repository] : [];
    },
    [userId, organizationId]
  );
  const githubRepositories = useMemo(
    () => (githubQuery.data?.repositories ?? []).flatMap(row => normalize(row)),
    [githubQuery.data, normalize]
  );
  const gitlabRepositories = useMemo(
    () => (gitlabQuery.data?.repositories ?? []).flatMap(row => normalize(row)),
    [gitlabQuery.data, normalize]
  );
  const bitbucketRepositories = useMemo(
    () =>
      bitbucketQuery.data?.status === 'available'
        ? bitbucketQuery.data.repositories.flatMap(row => normalize(row))
        : [],
    [bitbucketQuery.data, normalize]
  );

  const recentlyUsed = useMemo(() => {
    const byKey = new Map(
      [...githubRepositories, ...gitlabRepositories, ...bitbucketRepositories].map(repo => [
        repo.key,
        repo,
      ])
    );
    // Old URL-only or unresolved recents stay in history, not in another identity's picker.
    // Remove after old clients/records disappear and the 30-day ledger window expires.
    return dedupeRepositoriesByPlatformAndFullName(
      (recentRepoData?.repositories ?? []).flatMap(recent => {
        if (recent.identity?.kind !== 'resolved' || recent.identity.accountId !== userId) {
          return [];
        }
        const match = byKey.get(
          repositoryResourceKey(recent.identity.accountId, recent.identity.reference)
        );
        return match ? [match] : [];
      })
    );
  }, [recentRepoData, userId, githubRepositories, gitlabRepositories, bitbucketRepositories]);

  const githubStatus = resolveProviderStatus({
    isLoading: !userId || githubQuery.isLoading || githubQuery.isRefetching || isRefreshingGitHub,
    isError: githubQuery.isError || Boolean(githubQuery.data?.errorMessage),
    errorCode: readTrpcErrorField(githubQuery.error, 'code'),
    integrationInstalled: githubQuery.data?.integrationInstalled,
    repositoryCount: githubRepositories.length,
    hasUnresolved: (githubQuery.data?.repositories.length ?? 0) > githubRepositories.length,
  });
  const gitlabStatus = resolveProviderStatus({
    isLoading:
      !userId ||
      gitlabQuery.isLoading ||
      gitlabQuery.isRefetching ||
      providerRefreshCounts.gitlab > 0,
    isError: gitlabQuery.isError || Boolean(gitlabQuery.data?.errorMessage),
    errorCode: readTrpcErrorField(gitlabQuery.error, 'code'),
    integrationInstalled: gitlabQuery.data?.integrationInstalled,
    repositoryCount: gitlabRepositories.length,
    hasUnresolved: (gitlabQuery.data?.repositories.length ?? 0) > gitlabRepositories.length,
  });
  const bitbucketStatus = resolveBitbucketStatus({
    isLoading:
      !userId ||
      bitbucketQuery.isLoading ||
      bitbucketQuery.isRefetching ||
      providerRefreshCounts.bitbucket > 0,
    isError: bitbucketQuery.isError,
    status: bitbucketQuery.data?.status,
    repositoryCount: bitbucketRepositories.length,
    errorCode: readTrpcErrorField(bitbucketQuery.error, 'code'),
    hasUnresolved:
      bitbucketQuery.data?.status === 'available' &&
      bitbucketQuery.data.repositories.length > bitbucketRepositories.length,
  });

  const { groups, recents } = useMemo<RepositoryGroups>(
    () =>
      resolveRepositoryGroups({
        organizationId,
        github: { key: 'github', status: githubStatus, repositories: githubRepositories },
        gitlab: { key: 'gitlab', status: gitlabStatus, repositories: gitlabRepositories },
        bitbucket: {
          key: 'bitbucket',
          status: bitbucketStatus,
          repositories: bitbucketRepositories,
        },
        recents: recentlyUsed,
      }),
    [
      organizationId,
      githubStatus,
      githubRepositories,
      gitlabStatus,
      gitlabRepositories,
      bitbucketStatus,
      bitbucketRepositories,
      recentlyUsed,
    ]
  );
  const repositories = useMemo(
    () =>
      dedupeRepositoriesByPlatformAndFullName([
        ...recents,
        ...groups.flatMap(group => group.repositories),
      ]),
    [recents, groups]
  );

  const forceFreshProvider = useCallback(
    async (platform: 'gitlab' | 'bitbucket') => {
      if (
        !scope.userId ||
        currentScope.current !== scope ||
        (platform === 'bitbucket' && !scope.bitbucketFresh)
      ) {
        return;
      }
      setProviderRefreshCounts(counts => ({ ...counts, [platform]: counts[platform] + 1 }));
      try {
        if (platform === 'gitlab') {
          const fresh = await queryClient.fetchQuery({ ...scope.gitlabFresh, staleTime: 0 });
          if (currentScope.current !== scope) {
            return;
          }
          await queryClient.cancelQueries({ queryKey: scope.gitlab.queryKey, exact: true });
          if (currentScope.current !== scope) {
            return;
          }
          queryClient.setQueryData(scope.gitlab.queryKey, fresh);
        } else if (scope.bitbucketFresh) {
          const fresh = await queryClient.fetchQuery({ ...scope.bitbucketFresh, staleTime: 0 });
          if (currentScope.current !== scope) {
            return;
          }
          // Only a transient outage permits the previous authorized snapshot to remain usable.
          if (fresh.status === 'temporarily_unavailable') {
            throw new Error('Bitbucket repositories are temporarily unavailable');
          }
          await queryClient.cancelQueries({ queryKey: scope.bitbucket.queryKey, exact: true });
          if (currentScope.current !== scope) {
            return;
          }
          queryClient.setQueryData(scope.bitbucket.queryKey, fresh);
        }
      } catch (error) {
        if (currentScope.current !== scope) {
          return;
        }
        await queryClient.cancelQueries({ queryKey: scope[platform].queryKey, exact: true });
        if (currentScope.current !== scope) {
          return;
        }
        if (setRepositoryDiscoveryError(queryClient, scope[platform].queryKey, error) === 'error') {
          throw error;
        }
      } finally {
        if (currentScope.current === scope) {
          setProviderRefreshCounts(counts => ({ ...counts, [platform]: counts[platform] - 1 }));
        }
      }
    },
    [scope, queryClient]
  );

  const refreshReposForceFresh = useCallback(async () => {
    if (currentScope.current !== scope) {
      return;
    }
    const results = await Promise.allSettled([
      refreshGitHubForceFresh(),
      forceFreshProvider('gitlab'),
      forceFreshProvider('bitbucket'),
    ]);
    // GitHub handles its own errors. Report current GitLab/Bitbucket failures once.
    if (
      currentScope.current === scope &&
      (results[1].status === 'rejected' || results[2].status === 'rejected')
    ) {
      toast.error(i18n.t('agentChat.newSession.couldNotRefreshRepositories'));
    }
  }, [scope, refreshGitHubForceFresh, forceFreshProvider]);

  const refreshAfterReturn = useCallback(
    async (platform: 'gitlab' | 'bitbucket') => {
      try {
        await forceFreshProvider(platform);
      } catch {
        if (currentScope.current === scope) {
          toast.error(
            i18n.t(
              platform === 'gitlab'
                ? 'codeReviewer.providerConnect.gitlabError'
                : 'codeReviewer.providerConnect.bitbucketError'
            )
          );
        }
      }
    },
    [scope, forceFreshProvider]
  );
  const { markLaunched: markGitLabLaunched, clearLaunch: clearGitLabLaunch } =
    useExternalAuthReturn(() => {
      void refreshAfterReturn('gitlab');
    });
  const { markLaunched: markBitbucketLaunched, clearLaunch: clearBitbucketLaunch } =
    useExternalAuthReturn(() => {
      void refreshAfterReturn('bitbucket');
    });
  useEffect(() => {
    currentScope.current = scope;
    setProviderRefreshCounts({ gitlab: 0, bitbucket: 0 });
    return () => {
      currentScope.current = null;
      clearGitLabLaunch();
      clearBitbucketLaunch();
      for (const options of [
        scope.github,
        scope.gitlab,
        scope.bitbucket,
        scope.gitlabFresh,
        scope.bitbucketFresh,
      ]) {
        if (options) {
          void scope.queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
        }
      }
    };
  }, [scope, clearGitLabLaunch, clearBitbucketLaunch]);

  const openIntegration = useCallback(
    (platform: RepositoryPlatform) => {
      if (!scope.userId || currentScope.current !== scope) {
        return;
      }
      if (platform === 'github') {
        openGitHubIntegration();
        return;
      }
      if (platform === 'bitbucket' && !organizationId) {
        return;
      }
      const markLaunched = platform === 'gitlab' ? markGitLabLaunched : markBitbucketLaunched;
      const clearLaunch = platform === 'gitlab' ? clearGitLabLaunch : clearBitbucketLaunch;
      void (async () => {
        try {
          markLaunched();
          const url =
            platform === 'bitbucket' && organizationId
              ? getBitbucketIntegrationUrl(WEB_BASE_URL, organizationId)
              : getGitLabIntegrationUrl(WEB_BASE_URL, organizationId);
          const trigger = await openAuthorizationAndWaitForReturn(Platform.OS, url);
          if (currentScope.current !== scope) {
            return;
          }
          if (trigger === 'sheet-close') {
            clearLaunch();
            await refreshAfterReturn(platform);
          }
        } catch {
          if (currentScope.current === scope) {
            clearLaunch();
            toast.error(
              i18n.t(
                platform === 'gitlab'
                  ? 'codeReviewer.providerConnect.gitlabError'
                  : 'codeReviewer.providerConnect.bitbucketError'
              )
            );
          }
        }
      })();
    },
    [
      scope,
      organizationId,
      openGitHubIntegration,
      markGitLabLaunched,
      markBitbucketLaunched,
      clearGitLabLaunch,
      clearBitbucketLaunch,
      refreshAfterReturn,
    ]
  );

  const isRetrying =
    githubQuery.isRefetching ||
    gitlabQuery.isRefetching ||
    bitbucketQuery.isRefetching ||
    isRefreshingGitHub ||
    providerRefreshCounts.gitlab > 0 ||
    providerRefreshCounts.bitbucket > 0;

  const reposSettled =
    Boolean(userId) &&
    groups.every(
      group =>
        group.status !== 'loading' &&
        group.status !== 'error' &&
        group.status !== 'identity-unavailable'
    );

  return {
    repositories,
    recents,
    groups,
    isRetrying,
    reposSettled,
    openIntegration,
    refreshReposForceFresh,
  };
}
