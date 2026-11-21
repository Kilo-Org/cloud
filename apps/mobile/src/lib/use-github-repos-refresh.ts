import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { appShellHandoffUrl } from '@/lib/app-shell-handoff';
import { isExpectedAuthFailure } from '@/lib/auth/trpc-unauthorized';
import {
  openAuthorizationAndWaitForReturn,
  reportLateLaunchFailure,
} from '@/lib/pr-review/connect-gate-platform';
import { useTRPC } from '@/lib/trpc';
import {
  shouldClearConnectCheckFailed,
  shouldSetConnectCheckFailed,
  shouldToastRepositoryRefreshFailure,
} from './use-github-repos-refresh-helpers';

// ── Hook ────────────────────────────────────────────────────────────

type UseGitHubReposRefreshParams = {
  organizationId: string | undefined;
  integrationInstalled: boolean | undefined;
};

type UseGitHubReposRefreshResult = {
  /**
   * Mints the hand-off token, opens the browser, refetches on return, and reports
   * every failure. Resolves when the flow ends, so a caller can hold its own
   * busy state over the whole of it instead of returning before the mint settles.
   */
  openGitHubIntegration: () => Promise<void>;
  /**
   * Rejects when the refresh fails and shows no toast: the caller refreshes
   * every provider at once and reports their failures with one toast.
   */
  refreshReposForceFresh: () => Promise<void>;
  isRefreshingRepos: boolean;
  connectCheckFailed: boolean;
};

export function useGitHubReposRefresh({
  organizationId,
  integrationInstalled,
}: UseGitHubReposRefreshParams): UseGitHubReposRefreshResult {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [isRefreshingRepos, setIsRefreshingRepos] = useState(false);
  const [connectCheckFailed, setConnectCheckFailed] = useState(false);

  // ── connectCheckFailed clear-on-input effect ──────────────────────
  useEffect(() => {
    if (integrationInstalled === true && connectCheckFailed) {
      setConnectCheckFailed(false);
    }
  }, [integrationInstalled, connectCheckFailed]);

  // ── Force-fresh refetch ──────────────────────────────────────────
  // Rejects on failure; each caller decides how to report it.
  const performForceFresh = useCallback(
    async (isReturnTriggered: boolean) => {
      setIsRefreshingRepos(true);
      try {
        const fresh = await queryClient.query({
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

        // Connect check failed flag management
        const installed = fresh.integrationInstalled;
        if (
          shouldSetConnectCheckFailed({
            isReturnTriggered,
            integrationInstalled: installed,
          })
        ) {
          setConnectCheckFailed(true);
        } else if (shouldClearConnectCheckFailed({ integrationInstalled: installed })) {
          setConnectCheckFailed(false);
        }
      } finally {
        setIsRefreshingRepos(false);
      }
    },
    [organizationId, trpc, queryClient]
  );

  // ── Open GitHub integration ──────────────────────────────────────
  const openGitHubIntegration = useCallback(async () => {
    try {
      const url = await appShellHandoffUrl({
        page: 'github-app',
        ...(organizationId ? { organizationId } : {}),
      });
      const wait = await openAuthorizationAndWaitForReturn(url);
      // A launch that fails after the app's own return edge ended the wait
      // never reaches the catch below.
      reportLateLaunchFailure(wait, {
        onFailure: () => {
          toast.error(i18n.t('codeReviewer.providerConnect.githubError'));
        },
      });
    } catch (error: unknown) {
      // An ended session shows its own toast over the login screen.
      if (!isExpectedAuthFailure(error)) {
        toast.error(i18n.t('codeReviewer.providerConnect.githubError'));
      }
      return;
    }
    try {
      await performForceFresh(true);
    } catch (error: unknown) {
      if (shouldToastRepositoryRefreshFailure([error])) {
        toast.error(i18n.t('agentChat.newSession.couldNotRefreshRepositories'));
      }
    }
  }, [organizationId, performForceFresh]);

  const refreshReposForceFresh = useCallback(async () => {
    await performForceFresh(false);
  }, [performForceFresh]);

  return {
    openGitHubIntegration,
    refreshReposForceFresh,
    isRefreshingRepos,
    connectCheckFailed,
  };
}
