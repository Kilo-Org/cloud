import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus, Platform } from 'react-native';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { type TRPCQueryKey } from '@trpc/tanstack-react-query';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { resolveProviderStatus } from '@/components/agents/new-session-repository-state';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { WEB_BASE_URL } from '@/lib/config';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { openAuthorizationAndWaitForReturn } from '@/lib/pr-review/connect-gate-platform';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';
import {
  shouldClearConnectCheckFailed,
  shouldSetConnectCheckFailed,
} from './use-github-repos-refresh-helpers';

/** Add cache identity outside the tRPC path and input, preserving its public tuple. */
export function withRepositoryAccount<T extends { queryKey: TRPCQueryKey }>(
  options: T,
  accountId: string | undefined
): Omit<T, 'queryKey'> & { queryKey: TRPCQueryKey } {
  const details = { ...options.queryKey[1], accountId };
  return { ...options, queryKey: [options.queryKey[0], details] };
}

/** Keep the failure in the normal cache so remounting cannot revive revoked rows. */
export function setRepositoryDiscoveryError(
  queryClient: QueryClient,
  queryKey: TRPCQueryKey,
  error: unknown
) {
  const status = resolveProviderStatus({
    isLoading: false,
    isError: true,
    integrationInstalled: undefined,
    repositoryCount: 0,
    errorCode: readTrpcErrorField(error, 'code'),
  });
  // The permission handler can remove both cache variants before this catch runs.
  const query = queryClient.getQueryCache().build<unknown, unknown>(queryClient, { queryKey });
  query.setState({
    error,
    errorUpdatedAt: Date.now(),
    errorUpdateCount: query.state.errorUpdateCount + 1,
    status: 'error',
    ...(status === 'connect' || status === 'access-denied' ? { data: undefined } : {}),
  });
  return status;
}

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
  const { userId } = useCurrentUserId();
  const [refreshCount, setRefreshCount] = useState(0);
  const [connectCheckFailed, setConnectCheckFailed] = useState(false);
  const scope = useMemo(
    () => ({
      userId,
      queryClient,
      options: withRepositoryAccount(
        organizationId
          ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
              organizationId,
              forceRefresh: true,
            })
          : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({ forceRefresh: true }),
        userId
      ),
      normal: withRepositoryAccount(
        organizationId
          ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
              organizationId,
              forceRefresh: false,
            })
          : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({ forceRefresh: false }),
        userId
      ),
    }),
    [userId, organizationId, queryClient, trpc]
  );
  const currentScope = useRef<typeof scope | null>(scope);
  currentScope.current = scope;

  // Android consumes this sentinel only after a browser launch in the current scope.
  const launchedAt = useRef<number | null>(null);
  useEffect(() => {
    currentScope.current = scope;
    setRefreshCount(0);
    setConnectCheckFailed(false);
    return () => {
      currentScope.current = null;
      launchedAt.current = null;
      void scope.queryClient.cancelQueries({ queryKey: scope.options.queryKey, exact: true });
      void scope.queryClient.cancelQueries({ queryKey: scope.normal.queryKey, exact: true });
    };
  }, [scope]);

  useEffect(() => {
    if (integrationInstalled === true && connectCheckFailed) {
      setConnectCheckFailed(false);
    }
  }, [integrationInstalled, connectCheckFailed]);

  const performForceFresh = useCallback(
    async (isReturnTriggered: boolean) => {
      if (!scope.userId || currentScope.current !== scope) {
        return;
      }
      setRefreshCount(count => count + 1);
      try {
        const fresh = await queryClient.fetchQuery({ ...scope.options, staleTime: 0 });
        if (currentScope.current !== scope) {
          return;
        }
        // A pending normal response cannot overwrite the confirmed refresh result.
        await queryClient.cancelQueries({ queryKey: scope.normal.queryKey, exact: true });
        if (currentScope.current !== scope) {
          return;
        }
        queryClient.setQueryData(scope.normal.queryKey, fresh);
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
      } catch (error) {
        if (currentScope.current !== scope) {
          return;
        }
        await queryClient.cancelQueries({ queryKey: scope.normal.queryKey, exact: true });
        if (
          currentScope.current === scope &&
          setRepositoryDiscoveryError(queryClient, scope.normal.queryKey, error) === 'error'
        ) {
          toast.error(i18n.t('agentChat.newSession.couldNotRefreshRepositories'));
        }
      } finally {
        if (currentScope.current === scope) {
          setRefreshCount(count => count - 1);
        }
      }
    },
    [scope, queryClient]
  );

  const performForceFreshRef = useRef(performForceFresh);
  performForceFreshRef.current = performForceFresh;
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }
    const handleChange = (nextState: AppStateStatus) => {
      if (nextState !== 'active' || launchedAt.current === null) {
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

  const openGitHubIntegration = useCallback(() => {
    if (!scope.userId || currentScope.current !== scope) {
      return;
    }
    void (async () => {
      try {
        launchedAt.current = Date.now();
        const { token } = await trpcClient.githubApps.mintInstallState.mutate({
          organizationId: organizationId ?? undefined,
          returnTo: '/cloud/sessions',
        });
        if (currentScope.current !== scope) {
          return;
        }
        const trigger = await openAuthorizationAndWaitForReturn(
          Platform.OS,
          getGitHubIntegrationUrl(WEB_BASE_URL, organizationId, token)
        );
        if (currentScope.current !== scope) {
          return;
        }
        if (trigger === 'sheet-close') {
          // iOS refreshes on sheet close; Android consumes the foreground sentinel.
          launchedAt.current = null;
          await performForceFresh(true);
        }
      } catch {
        if (currentScope.current === scope) {
          launchedAt.current = null;
          toast.error(i18n.t('codeReviewer.providerConnect.githubError'));
        }
      }
    })();
  }, [scope, organizationId, performForceFresh]);

  const refreshReposForceFresh = useCallback(async () => {
    await performForceFresh(false);
  }, [performForceFresh]);

  return {
    openGitHubIntegration,
    refreshReposForceFresh,
    isRefreshingRepos: refreshCount > 0,
    connectCheckFailed,
  };
}
