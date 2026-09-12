/* eslint-disable max-lines -- One hook wires the GitHub, GitLab, and Bitbucket provider queries, recents resolution, and connect/refresh flows end-to-end. */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import {
  dedupeRepositoriesByPlatformAndFullName,
  detectRepositoryPlatform,
  getNewSessionBranchState,
  type NewSessionRepository,
  type RepositoryGroup,
  type RepositoryGroups,
  repositoryIdentityKey,
  type RepositoryPlatform,
  resolveBitbucketStatus,
  resolveProviderStatus,
  resolveRepositoryGroups,
  setNewSessionBranchScope,
  subscribeNewSessionBranchState,
} from '@/components/agents/new-session-repository-state';
import { formatGitUrlProject } from '@/components/agents/session-list-helpers';
import { i18n } from '@/i18n';
import { WEB_BASE_URL } from '@/lib/config';
import { useRecentAgentRepositories } from '@/lib/hooks/use-agent-sessions';
import { getBitbucketIntegrationUrl, getGitLabIntegrationUrl } from '@/lib/integration-urls';
import { openAuthorizationAndWaitForReturn } from '@/lib/pr-review/connect-gate-platform';
import { useExternalAuthReturn } from '@/lib/external-auth/use-external-auth-return';
import { classifyProviderErrorCode } from '@/lib/code-reviewer-status';
import { useGitHubReposRefresh } from '@/lib/use-github-repos-refresh';
import { trpcClient, useTRPC } from '@/lib/trpc';

type UseNewSessionReposArgs = {
  organizationId: string | undefined;
};

type UseNewSessionReposResult = {
  /** Merged + deduped rows (recents first) for the picker and prefill. */
  repositories: NewSessionRepository[];
  /** Recently used rows resolved against connected providers ("Recently used" picker section). */
  recents: NewSessionRepository[];
  groups: RepositoryGroup[];
  isRetrying: boolean;
  /** True once every provider query has settled and at least one repo is visible. */
  reposSettled: boolean;
  openIntegration: (platform: RepositoryPlatform) => void;
  refreshReposForceFresh: () => Promise<void>;
};

export function useNewSessionRepos({
  organizationId,
}: UseNewSessionReposArgs): UseNewSessionReposResult {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Publish the route's organization scope for the branch queries. The route
  // hands this hook the scope already, and `useRepositoryBranches` reads it
  // from the shared new-session branch state rather than from props the
  // repository section is not given.
  useEffect(() => {
    setNewSessionBranchScope(organizationId);
  }, [organizationId]);

  const githubQuery = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  const gitlabQuery = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitLabRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  // Bitbucket is organization-only: the query is disabled without an org.
  const bitbucketQuery = useQuery({
    ...trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryOptions({
      organizationId: organizationId ?? '',
      forceRefresh: false,
    }),
    enabled: Boolean(organizationId),
  });

  const { data: recentRepoData } = useRecentAgentRepositories({ organizationId });

  const {
    openGitHubIntegration,
    refreshReposForceFresh: refreshGitHubForceFresh,
    isRefreshingRepos: isRefreshingGitHub,
  } = useGitHubReposRefresh({
    organizationId,
    integrationInstalled: githubQuery.data?.integrationInstalled,
  });

  const githubRepositories = useMemo<NewSessionRepository[]>(
    () =>
      (githubQuery.data?.repositories ?? []).map(repo => ({
        platform: 'github',
        fullName: repo.fullName,
        isPrivate: repo.private,
      })),
    [githubQuery.data]
  );

  const gitlabRepositories = useMemo<NewSessionRepository[]>(
    () =>
      (gitlabQuery.data?.repositories ?? []).map(repo => ({
        platform: 'gitlab',
        fullName: repo.fullName,
        isPrivate: repo.private,
      })),
    [gitlabQuery.data]
  );

  const bitbucketRepositories = useMemo<NewSessionRepository[]>(() => {
    const data = bitbucketQuery.data;
    if (data?.status !== 'available') {
      return [];
    }
    return data.repositories.map(repo => ({
      platform: 'bitbucket',
      fullName: repo.fullName,
      isPrivate: repo.private,
      workspaceUuid: repo.workspaceUuid,
      repositoryUuid: repo.id,
    }));
  }, [bitbucketQuery.data]);

  // Recently used rows: only recents that resolve to a connected repository
  // appear, and they are deduped by platform + fullName.
  const recentlyUsed = useMemo<NewSessionRepository[]>(() => {
    const recentList = recentRepoData?.repositories;
    if (!recentList?.length) {
      return [];
    }
    const unified = [...githubRepositories, ...gitlabRepositories, ...bitbucketRepositories];
    const byKey = new Map(unified.map(repo => [repoKey(repo), repo]));
    const seen = new Set<string>();
    const result: NewSessionRepository[] = [];
    for (const recent of recentList) {
      const platform = detectRepositoryPlatform(recent.gitUrl);
      const fullName = formatGitUrlProject(recent.gitUrl);
      const match =
        platform && fullName ? byKey.get(`${platform}/${fullName.toLowerCase()}`) : undefined;
      if (match) {
        const key = repoKey(match);
        if (!seen.has(key)) {
          seen.add(key);
          result.push(match);
        }
      }
    }
    return result;
  }, [recentRepoData, githubRepositories, gitlabRepositories, bitbucketRepositories]);

  const repositories = useMemo(
    () =>
      dedupeRepositoriesByPlatformAndFullName([
        ...recentlyUsed,
        ...githubRepositories,
        ...gitlabRepositories,
        ...bitbucketRepositories,
      ]),
    [recentlyUsed, githubRepositories, gitlabRepositories, bitbucketRepositories]
  );

  const githubStatus = resolveProviderStatus({
    isLoading: githubQuery.isLoading,
    isError: githubQuery.isError,
    integrationInstalled: githubQuery.data?.integrationInstalled,
    repositoryCount: githubRepositories.length,
  });
  const gitlabStatus = resolveProviderStatus({
    isLoading: gitlabQuery.isLoading,
    isError: gitlabQuery.isError,
    integrationInstalled: gitlabQuery.data?.integrationInstalled,
    repositoryCount: gitlabRepositories.length,
  });
  const bitbucketStatus = resolveBitbucketStatus({
    isLoading: bitbucketQuery.isLoading,
    isError: bitbucketQuery.isError,
    status: bitbucketQuery.data?.status,
    repositoryCount: bitbucketRepositories.length,
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

  // ── Force-fresh per-provider refresh ──────────────────────────────
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);

  const forceFreshGitLab = useCallback(async () => {
    const fresh = await queryClient.fetchQuery({
      ...(organizationId
        ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
            organizationId,
            forceRefresh: true,
          })
        : trpc.cloudAgentNext.listGitLabRepositories.queryOptions({
            forceRefresh: true,
          })),
      staleTime: 0,
    });
    queryClient.setQueryData(
      organizationId
        ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryKey({
            organizationId,
            forceRefresh: false,
          })
        : trpc.cloudAgentNext.listGitLabRepositories.queryKey({
            forceRefresh: false,
          }),
      fresh
    );
  }, [organizationId, trpc, queryClient]);

  const forceFreshBitbucket = useCallback(async () => {
    if (!organizationId) {
      return;
    }
    const fresh = await queryClient.fetchQuery({
      ...trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryOptions({
        organizationId,
        forceRefresh: true,
      }),
      staleTime: 0,
    });
    // A non-`available` force-fresh result is a refresh failure, not a
    // cacheable snapshot: writing it over an existing `available` cache would
    // clear good rows on a transient Bitbucket outage. Throw so
    // `refreshReposForceFresh` toasts `couldNotRefreshRepositories`.
    if (fresh.status !== 'available') {
      throw new Error('Bitbucket repositories are not available');
    }
    queryClient.setQueryData(
      trpc.organizations.cloudAgentNext.listBitbucketRepositories.queryKey({
        organizationId,
        forceRefresh: false,
      }),
      fresh
    );
  }, [organizationId, trpc, queryClient]);

  const refreshReposForceFresh = useCallback(async () => {
    setIsRefreshingProviders(true);
    try {
      const results = await Promise.allSettled([
        refreshGitHubForceFresh(),
        forceFreshGitLab(),
        forceFreshBitbucket(),
      ]);
      // GitHub resolves always (it catches its own errors and toasts), so a
      // rejection here is a GitLab or Bitbucket force-fresh failure. Toast once.
      if (results[1].status === 'rejected' || results[2].status === 'rejected') {
        toast.error(i18n.t('agentChat.newSession.couldNotRefreshRepositories'));
      }
    } finally {
      setIsRefreshingProviders(false);
    }
  }, [refreshGitHubForceFresh, forceFreshGitLab, forceFreshBitbucket]);

  // ── Per-provider connect ──────────────────────────────────────────
  // Android: `openAuthorizationAndWaitForReturn` returns `'app-foreground'`
  // (the browser launch is fire-and-forget), so each provider's refresh runs
  // from a shared foreground listener when the app returns.
  const { markLaunched: markGitLabLaunched, clearLaunch: clearGitLabLaunch } =
    useExternalAuthReturn(() => {
      void forceFreshGitLab();
    });
  const { markLaunched: markBitbucketLaunched, clearLaunch: clearBitbucketLaunch } =
    useExternalAuthReturn(() => {
      void forceFreshBitbucket();
    });

  const openGitLabIntegration = useCallback(() => {
    void (async () => {
      try {
        markGitLabLaunched();
        const trigger = await openAuthorizationAndWaitForReturn(
          Platform.OS,
          getGitLabIntegrationUrl(WEB_BASE_URL, organizationId)
        );
        if (trigger === 'sheet-close') {
          clearGitLabLaunch();
          await forceFreshGitLab();
        }
      } catch {
        clearGitLabLaunch();
        toast.error(i18n.t('codeReviewer.providerConnect.gitlabError'));
      }
    })();
  }, [organizationId, forceFreshGitLab, markGitLabLaunched, clearGitLabLaunch]);

  const openBitbucketIntegration = useCallback(() => {
    if (!organizationId) {
      return;
    }
    void (async () => {
      try {
        markBitbucketLaunched();
        const trigger = await openAuthorizationAndWaitForReturn(
          Platform.OS,
          getBitbucketIntegrationUrl(WEB_BASE_URL, organizationId)
        );
        if (trigger === 'sheet-close') {
          clearBitbucketLaunch();
          await forceFreshBitbucket();
        }
      } catch {
        clearBitbucketLaunch();
        toast.error(i18n.t('codeReviewer.providerConnect.bitbucketError'));
      }
    })();
  }, [organizationId, forceFreshBitbucket, markBitbucketLaunched, clearBitbucketLaunch]);

  const openIntegration = useCallback(
    (platform: RepositoryPlatform) => {
      if (platform === 'github') {
        openGitHubIntegration();
      } else if (platform === 'gitlab') {
        openGitLabIntegration();
      } else {
        openBitbucketIntegration();
      }
    },
    [openGitHubIntegration, openGitLabIntegration, openBitbucketIntegration]
  );

  const isRetrying =
    githubQuery.isRefetching ||
    gitlabQuery.isRefetching ||
    bitbucketQuery.isRefetching ||
    isRefreshingGitHub ||
    isRefreshingProviders;

  const reposSettled =
    !githubQuery.isLoading &&
    !gitlabQuery.isLoading &&
    !bitbucketQuery.isLoading &&
    repositories.length > 0;

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

function repoKey(repository: NewSessionRepository): string {
  return `${repository.platform}/${repository.fullName.toLowerCase()}`;
}

// ── Branches of the selected repository ──────────────────────────────

export type RepositoryBranchesState = {
  /** The provider's default branch, or null when it reports none. */
  defaultBranch: string | null;
  branches: string[];
  /** The query runs only for a selected repository in a scope that can serve it. */
  isEnabled: boolean;
  isLoading: boolean;
  /** A transient failure: the caller offers a retry. */
  isRetryableError: boolean;
  /** FORBIDDEN/UNAUTHORIZED/NOT_FOUND — a retry cannot fix it, so no retry CTA. */
  isPermanentError: boolean;
  isRetrying: boolean;
  retry: () => void;
};

/**
 * Branches of the selected repository, from the provider, through the s4
 * `listRepositoryBranches` procedures (organization variant when the
 * new-session route carries an organization).
 *
 * The query runs only when a repository is selected. Bitbucket is
 * organization-only, so a personal Bitbucket row never issues a request — the
 * server would refuse it with the org-only message, and the section explains
 * the restriction instead.
 *
 * The cache key carries the full repository identity: the procedure input
 * only accepts `platform` + `fullName`, so the Bitbucket workspace/repository
 * uuids are appended to the key here. Two same-named rows — across providers,
 * or across renamed Bitbucket workspaces — can never read each other's
 * branches out of the cache.
 */
export function useRepositoryBranches(
  repository: NewSessionRepository | null
): RepositoryBranchesState {
  const trpc = useTRPC();
  const { isScopeReady, organizationId } = useSyncExternalStore(
    subscribeNewSessionBranchState,
    getNewSessionBranchState
  );

  const platform: RepositoryPlatform = repository?.platform ?? 'github';
  const fullName = repository?.fullName ?? '';
  const isEnabled =
    repository !== null &&
    isScopeReady &&
    fullName !== '' &&
    !(platform === 'bitbucket' && !organizationId);

  const personalInput = { platform, repository: { fullName } };
  const organizationInput = { organizationId: organizationId ?? '', ...personalInput };
  const identity = repository ? repositoryIdentityKey(repository) : 'none';

  const branchQuery = useQuery({
    queryKey: [
      ...(organizationId
        ? trpc.organizations.cloudAgentNext.listRepositoryBranches.queryKey(organizationInput)
        : trpc.cloudAgentNext.listRepositoryBranches.queryKey(personalInput)),
      identity,
    ],
    queryFn: async () => {
      const listing = organizationId
        ? await trpcClient.organizations.cloudAgentNext.listRepositoryBranches.query(
            organizationInput
          )
        : await trpcClient.cloudAgentNext.listRepositoryBranches.query(personalInput);
      return listing;
    },
    enabled: isEnabled,
  });

  const errorCode = branchQuery.isError
    ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the query fn calls tRPC directly, so the error is a TRPCClientError carrying `data.code`
      (branchQuery.error as { data?: { code?: string } } | null)?.data?.code
    : undefined;
  const { permanent } = classifyProviderErrorCode(errorCode);

  const retry = useCallback(() => {
    void branchQuery.refetch();
  }, [branchQuery]);

  return {
    defaultBranch: branchQuery.data?.defaultBranch ?? null,
    branches: branchQuery.data?.branches ?? [],
    isEnabled,
    isLoading: isEnabled && branchQuery.isPending,
    isRetryableError: branchQuery.isError && !permanent,
    isPermanentError: branchQuery.isError && permanent,
    isRetrying: branchQuery.isFetching && branchQuery.isError,
    retry,
  };
}
