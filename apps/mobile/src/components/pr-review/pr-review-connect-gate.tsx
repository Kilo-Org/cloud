import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlugZap, RefreshCcw, ShieldAlert } from '@/components/ui/icons';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Platform, View } from 'react-native';
import { usePathname } from 'expo-router';
import { CenteredState } from '@/components/centered-state';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { WEB_BASE_URL } from '@/lib/config';
import { getBitbucketIntegrationUrl, getGitLabIntegrationUrl } from '@/lib/integration-urls';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useExternalAuthReturn } from '@/lib/external-auth/use-external-auth-return';
import { openAuthorizationAndWaitForReturn } from '@/lib/pr-review/connect-gate-platform';
import { selectPrReviewGateView } from '@/lib/pr-review/pr-review-connect-gate-view';
import { type ProviderPrPlatform } from '@/lib/pr-review/provider-pr-ref';
import { useTRPC } from '@/lib/trpc';

type PrReviewConnectGateProps = {
  readonly children: ReactNode;
  /**
   * Which provider's connection this mount checks. The GitHub detail route
   * and every pre-s7 mount keep the default; the provider layout passes the
   * route's platform.
   */
  readonly platform?: ProviderPrPlatform;
  /** The selected organization for a provider check; null = personal scope. */
  readonly organizationId?: string | null;
};

/**
 * Wraps every PR-review surface, with one arm per provider:
 *
 *  - GitHub: the user's GitHub identity (separate from a per-org GitHub App
 *    installation) is required to post review comments — the existing
 *    `getUserAuthorization` check and `connectUserAuthorization` CTA.
 *  - GitLab (personal + org) and Bitbucket (org): the integration status the
 *    s4 endpoints expose; the CTA opens the web integration page and the
 *    status refetches when the app returns.
 *  - Bitbucket personal: Cloud has no personal review scope, so the gate
 *    shows the org-only explanation with no CTA — nothing a retry could fix.
 *
 * Each arm handles the same states:
 *  - happy: connected → render children
 *  - retryable: the status check fails → QueryError + Retry
 *  - empty: not connected → EmptyState CTA into the provider's connect flow
 *  - non-retryable: Bitbucket personal → org-only explanation, no CTA
 *
 * The entry screen is provider-neutral — a pasted GitLab or Bitbucket link
 * must work for a user with no GitHub connection — so the gate is a
 * pass-through there; the provider gates protect each detail route.
 *
 * The GitHub CTA calls `githubApps.connectUserAuthorization` and opens the
 * returned URL with the platform-appropriate browser launcher (iOS native
 * auth session that resolves on sheet close; Android custom tab that
 * resolves on app-foreground via AppState). Cancellation on either platform
 * simply leaves the gate showing — there's nothing to roll back because the
 * auth flow is server-driven.
 */
export function PrReviewConnectGate({
  children,
  platform = 'github',
  organizationId = null,
}: PrReviewConnectGateProps) {
  const pathname = usePathname();
  // The entry route (`(app)/pr-review` → pathname `/pr-review`) is the one
  // PR-review surface that serves all three providers at once; gating it on
  // any single connection would lock out the other two.
  if (pathname === '/pr-review') {
    return <>{children}</>;
  }
  if (platform === 'github') {
    return <GitHubConnectGate>{children}</GitHubConnectGate>;
  }
  return (
    <ProviderConnectGate platform={platform} organizationId={organizationId}>
      {children}
    </ProviderConnectGate>
  );
}

function GitHubConnectGate({ children }: Readonly<{ children: ReactNode }>) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const authorization = useQuery(trpc.githubApps.getUserAuthorization.queryOptions());
  const connect = useMutation(
    trpc.githubApps.connectUserAuthorization.mutationOptions({
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  // Track the in-flight launch so a stale AppState 'active' transition
  // (from the user backgrounding the app before tapping Connect) doesn't
  // trigger a refetch on its own. iOS: openAuthSessionAsync already resolves
  // on sheet close, so we await it and refetch right there. Android:
  // openBrowserAsync is fire-and-forget, so the hook refetches on AppState
  // returning to 'active'.
  const refetchAuthorization = useCallback(() => {
    void authorization.refetch();
  }, [authorization]);
  const { markLaunched, clearLaunch } = useExternalAuthReturn(refetchAuthorization);
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const result = await connect.mutateAsync();
      markLaunched();
      const trigger = await openAuthorizationAndWaitForReturn(Platform.OS, result.authorizationUrl);
      if (trigger === 'sheet-close') {
        // iOS: refetch immediately. Clear the launch sentinel so the
        // AppState handler (if it ever fires) doesn't double-refetch.
        clearLaunch();
        await authorization.refetch();
        await queryClient.invalidateQueries({
          queryKey: trpc.githubApps.getUserAuthorization.queryKey(),
        });
      }
      // Android: refetch is handled by the AppState listener when the app
      // returns to foreground. `openBrowserAsync` resolves as soon as the
      // browser is launched, so we must NOT clear the sentinel here — the
      // foreground handler clears it once it has consumed it.
    } catch {
      // mutateAsync already toasted; the openAuthorizationAndWaitForReturn
      // rejection means the browser failed to open — clear the sentinel so
      // a later unrelated foreground doesn't trigger a stray refetch, and
      // keep the gate showing.
      clearLaunch();
    } finally {
      setConnecting(false);
    }
  };

  const view = selectPrReviewGateView({
    platform: 'github',
    isError: authorization.isError,
    // `isPending` (no data yet) rather than `isLoading` (isPending &&
    // isFetching): a paused query (offline/unknown connectivity, empty cache)
    // is pending but not fetching, so isLoading is false and the gate would
    // otherwise fall through to Connect on a cold launch before NetInfo
    // settles.
    isLoading: authorization.isPending,
    connected: authorization.data?.connected === true,
    revoked: authorization.data?.revoked === true,
    organizationId: null,
  });

  if (view === 'error') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('common.prReview')} />
        <QueryError
          variant="server"
          title={t('prReview.connect.checkFailedTitle')}
          message={t('prReview.connect.checkFailedMessage')}
          onRetry={() => {
            void authorization.refetch();
          }}
          isRetrying={authorization.isFetching}
        />
      </View>
    );
  }

  if (view === 'loading') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('common.prReview')} />
        <CenteredState>
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        </CenteredState>
      </View>
    );
  }

  if (view === 'connect' || view === 'reconnect') {
    const revoked = view === 'reconnect';
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('common.prReview')} />
        <EmptyState
          icon={revoked ? ShieldAlert : PlugZap}
          title={revoked ? t('prReview.connect.reconnectTitle') : t('common.connectGithub')}
          description={
            revoked ? t('prReview.connect.reconnectDescription') : t('prReview.connect.description')
          }
          action={
            <Button
              className="mt-3 w-full flex-row gap-2"
              disabled={connecting}
              onPress={() => {
                void handleConnect();
              }}
            >
              {connecting ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <RefreshCcw size={16} color={colors.primaryForeground} />
              )}
              <Text>
                {revoked ? t('prReview.connect.reconnectTitle') : t('common.connectGithub')}
              </Text>
            </Button>
          }
        />
      </View>
    );
  }

  return <>{children}</>;
}

/**
 * GitLab / Bitbucket arm. The status query is the s4 integration status the
 * connect flow updates; a Bitbucket personal scope disables it entirely
 * because there is nothing to check — the selector renders the terminal
 * org-only explanation for that case.
 */
function ProviderConnectGate({
  platform,
  organizationId,
  children,
}: Readonly<{
  platform: Exclude<ProviderPrPlatform, 'github'>;
  organizationId: string | null;
  children: ReactNode;
}>) {
  const trpc = useTRPC();
  const colors = useThemeColors();
  const { t } = useTranslation();

  // The two providers answer with different status shapes, so each arm
  // subscribes to its own query and only one is enabled per mount — a
  // union of the two queryOptions types is not assignable to one useQuery.
  const gitlabOptions = useMemo(
    () =>
      organizationId
        ? trpc.organizations.reviewAgent.getGitLabStatus.queryOptions({ organizationId })
        : trpc.personalReviewAgent.getGitLabStatus.queryOptions(),
    [trpc, organizationId]
  );
  const bitbucketOptions = useMemo(
    () =>
      trpc.organizations.reviewAgent.getBitbucketReadiness.queryOptions({
        organizationId: organizationId ?? '',
      }),
    [trpc, organizationId]
  );
  // Bitbucket Cloud is organization-context only (s4): with no organization
  // selected there is no endpoint to ask, so the query stays disabled and the
  // gate renders the org-only explanation.
  const gitlabStatus = useQuery({ ...gitlabOptions, enabled: platform === 'gitlab' });
  const bitbucketStatus = useQuery({
    ...bitbucketOptions,
    enabled: platform === 'bitbucket' && organizationId !== null,
  });
  const status = platform === 'gitlab' ? gitlabStatus : bitbucketStatus;

  const refetchStatus = useCallback(() => {
    void status.refetch();
  }, [status]);
  const { markLaunched, clearLaunch } = useExternalAuthReturn(refetchStatus);
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      // The provider connections are web-side integrations: open the
      // existing integration page and re-check the status when the app
      // returns (pattern: `openAuthorizationAndWaitForReturn`).
      markLaunched();
      const integrationUrl =
        platform === 'gitlab'
          ? getGitLabIntegrationUrl(WEB_BASE_URL, organizationId ?? undefined)
          : getBitbucketIntegrationUrl(WEB_BASE_URL, organizationId ?? '');
      const trigger = await openAuthorizationAndWaitForReturn(Platform.OS, integrationUrl);
      if (trigger === 'sheet-close') {
        clearLaunch();
        await status.refetch();
      }
      // Android: the AppState listener in `useExternalAuthReturn` refetches
      // when the app returns to foreground; the sentinel stays set until it
      // consumes the launch.
    } catch {
      // The browser failed to open — clear the sentinel so a later unrelated
      // foreground doesn't trigger a stray refetch, and keep the gate showing.
      clearLaunch();
    } finally {
      setConnecting(false);
    }
  };

  const view = selectPrReviewGateView({
    platform,
    isError: status.isError,
    isLoading: status.isPending,
    connected: status.data?.connected === true,
    // `revoked` is the GitHub App's vocabulary; provider statuses only ever
    // answer connected / not connected.
    revoked: false,
    organizationId,
  });

  if (view === 'org-only') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('common.prReview')} />
        <EmptyState
          icon={ShieldAlert}
          title={t('agentChat.newSession.bitbucketOrganizationsOnly')}
          description={t('prReview.connect.bitbucketOrgOnlyDescription')}
        />
      </View>
    );
  }

  if (view === 'error') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('common.prReview')} />
        <QueryError
          variant="server"
          title={
            platform === 'gitlab'
              ? t('prReview.connect.checkFailedTitleGitLab')
              : t('prReview.connect.checkFailedTitleBitbucket')
          }
          message={t('prReview.connect.providerCheckFailedMessage')}
          onRetry={() => {
            void status.refetch();
          }}
          isRetrying={status.isFetching}
        />
      </View>
    );
  }

  if (view === 'loading') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('common.prReview')} />
        <CenteredState>
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        </CenteredState>
      </View>
    );
  }

  if (view === 'connect') {
    const title = platform === 'gitlab' ? t('common.connectGitlab') : t('common.connectBitbucket');
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('common.prReview')} />
        <EmptyState
          icon={PlugZap}
          title={title}
          description={
            platform === 'gitlab'
              ? t('prReview.connect.gitlabDescription')
              : t('prReview.connect.bitbucketDescription')
          }
          action={
            <Button
              className="mt-3 w-full flex-row gap-2"
              disabled={connecting}
              onPress={() => {
                void handleConnect();
              }}
            >
              {connecting ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <RefreshCcw size={16} color={colors.primaryForeground} />
              )}
              <Text>{title}</Text>
            </Button>
          }
        />
      </View>
    );
  }

  return <>{children}</>;
}
