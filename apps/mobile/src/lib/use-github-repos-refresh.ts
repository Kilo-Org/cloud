import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { WEB_BASE_URL } from '@/lib/config';
import { openAuthorizationAndWaitForReturn } from '@/lib/pr-review/connect-gate-platform';
import { trpcClient, useTRPC } from '@/lib/trpc';

// ── Hook ────────────────────────────────────────────────────────────

type UseGitHubReposRefreshParams = {
  organizationId: string | undefined;
};

type UseGitHubReposRefreshResult = {
  openGitHubIntegration: () => void;
  refreshReposForceFresh: () => Promise<void>;
  isRefreshingRepos: boolean;
};

export function useGitHubReposRefresh({
  organizationId,
}: UseGitHubReposRefreshParams): UseGitHubReposRefreshResult {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [isRefreshingRepos, setIsRefreshingRepos] = useState(false);

  // ── Force-fresh refetch ──────────────────────────────────────────
  const performForceFresh = useCallback(async () => {
    setIsRefreshingRepos(true);
    try {
      const fresh = await queryClient.fetchQuery({
        ...(organizationId
          ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
              organizationId,
              forceRefresh: true,
            })
          : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({
              forceRefresh: true,
            })),
        staleTime: 0,
      });
      queryClient.setQueryData(
        organizationId
          ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryKey({
              organizationId,
              forceRefresh: false,
            })
          : trpc.cloudAgentNext.listGitHubRepositories.queryKey({
              forceRefresh: false,
            }),
        fresh
      );
    } catch {
      toast.error(i18n.t('agentChat.newSession.couldNotRefreshRepositories'));
    } finally {
      setIsRefreshingRepos(false);
    }
  }, [organizationId, trpc, queryClient]);

  // ── Open GitHub integration ──────────────────────────────────────
  const openGitHubIntegration = useCallback(() => {
    void (async () => {
      try {
        const { token } = await trpcClient.githubApps.mintInstallState.mutate({
          organizationId: organizationId ?? undefined,
          returnTo: '/cloud/sessions',
        });
        await openAuthorizationAndWaitForReturn(
          getGitHubIntegrationUrl(WEB_BASE_URL, organizationId, token)
        );
        await performForceFresh();
      } catch {
        toast.error(i18n.t('codeReviewer.providerConnect.githubError'));
      }
    })();
  }, [organizationId, performForceFresh]);

  const refreshReposForceFresh = useCallback(async () => {
    await performForceFresh();
  }, [performForceFresh]);

  return {
    openGitHubIntegration,
    refreshReposForceFresh,
    isRefreshingRepos,
  };
}
