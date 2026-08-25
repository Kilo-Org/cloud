import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus, Platform } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { WEB_BASE_URL } from '@/lib/config';
import { openAuthorizationAndWaitForReturn } from '@/lib/pr-review/connect-gate-platform';
import { trpcClient, useTRPC } from '@/lib/trpc';
import {
  shouldClearConnectCheckFailed,
  shouldSetConnectCheckFailed,
} from './use-github-repos-refresh-helpers';

// ── Hook ────────────────────────────────────────────────────────────

type UseGitHubReposRefreshParams = {
  organizationId: string | undefined;
  integrationInstalled: boolean | undefined;
};

type UseGitHubReposRefreshResult = {
  openGitHubIntegration: () => void;
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

  // Sentinel: set before browser launch on Android, cleared on
  // consume or error. Prevents stale AppState from triggering refetch.
  const launchedAt = useRef<number | null>(null);

  // ── connectCheckFailed clear-on-input effect ──────────────────────
  useEffect(() => {
    if (integrationInstalled === true && connectCheckFailed) {
      setConnectCheckFailed(false);
    }
  }, [integrationInstalled, connectCheckFailed]);

  // ── Force-fresh refetch ──────────────────────────────────────────
  const performForceFresh = useCallback(
    async (isReturnTriggered: boolean) => {
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
      } catch {
        toast.error(i18n.t('agentChat.newSession.couldNotRefreshRepositories'));
      } finally {
        setIsRefreshingRepos(false);
      }
    },
    [organizationId, trpc, queryClient]
  );

  // Always-correct ref so Android AppState listener calls the latest
  // performForceFresh after organization/context changes.
  const performForceFreshRef = useRef(performForceFresh);
  performForceFreshRef.current = performForceFresh;

  // ── Android foreground listener ───────────────────────────────────
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }
    const handleChange = (nextState: AppStateStatus) => {
      if (nextState !== 'active') {
        return;
      }
      if (launchedAt.current === null) {
        return;
      }
      launchedAt.current = null;
      void performForceFreshRef.current(true);
    };
    const subscription = AppState.addEventListener('change', handleChange);
    return () => {
      subscription.remove();
    };
  }, []);

  // ── Open GitHub integration ──────────────────────────────────────
  const openGitHubIntegration = useCallback(() => {
    void (async () => {
      try {
        launchedAt.current = Date.now();
        const { token } = await trpcClient.githubApps.mintInstallState.mutate({
          organizationId: organizationId ?? undefined,
          returnTo: '/cloud/sessions',
        });
        const trigger = await openAuthorizationAndWaitForReturn(
          Platform.OS,
          getGitHubIntegrationUrl(WEB_BASE_URL, organizationId, token)
        );
        if (trigger === 'sheet-close') {
          // iOS: refetch immediately. Clear the sentinel so the AppState
          // handler (if it ever fires on iOS) doesn't double-refetch.
          launchedAt.current = null;
          await performForceFresh(true);
        }
        // Android: refetch is handled by the AppState listener when the
        // app returns to foreground. Do NOT clear the sentinel here — the
        // foreground handler clears it when consumed.
      } catch {
        // Browser failed to open — clear the sentinel so a later
        // unrelated foreground doesn't trigger a stray refetch.
        launchedAt.current = null;
        toast.error(i18n.t('codeReviewer.providerConnect.githubError'));
      }
    })();
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
