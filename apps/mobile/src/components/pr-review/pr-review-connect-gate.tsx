import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlugZap, ShieldAlert } from '@/components/ui/icons';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { usePathname } from 'expo-router';
import { CenteredState } from '@/components/centered-state';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { GitHubIcon } from '@/components/icons/github-icon';
import { PrReviewContextLine } from '@/components/pr-review/pr-review-context-line';
import { ProviderConnectGate } from '@/components/pr-review/pr-review-provider-connect-gate';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { launchConnectGateBrowser } from '@/lib/pr-review/connect-gate-platform';
import { selectPrReviewGateView } from '@/lib/pr-review/pr-review-connect-gate-view';
import { type ProviderPrPlatform } from '@/lib/pr-review/provider-pr-ref';
import { useTRPC } from '@/lib/trpc';

export { PR_REVIEW_ENTRY_HREF } from '@/components/pr-review/pr-review-provider-connect-gate';

/**
 * Cold deep links land straight on a gate state with no navigation history,
 * so `ScreenHeader` would render without a back control. The provider-neutral
 * inbox is the one exit every PR-review surface shares.
 */
const ENTRY_HREF = '/(app)/pr-review' as const;

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
 *    status refetches when the app returns (`ProviderConnectGate`).
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
 * returned URL with the shared auth-session launcher. Cancellation on either platform
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

  const [connecting, setConnecting] = useState(false);
  const connectAbort = useRef<AbortController | null>(null);
  useEffect(() => () => connectAbort.current?.abort(), []);

  const handleConnect = async () => {
    const controller = new AbortController();
    connectAbort.current = controller;
    setConnecting(true);
    try {
      const result = await connect.mutateAsync();
      await launchConnectGateBrowser(result.authorizationUrl, {
        signal: controller.signal,
        onOpenFailure: () => void toast.error(t('authErrors.couldNotOpenBrowser')),
        onReturn: async () => {
          await authorization.refetch();
          await queryClient.invalidateQueries({
            queryKey: trpc.githubApps.getUserAuthorization.queryKey(),
          });
        },
      });
    } catch {
      // mutateAsync toasted the server error; keep the gate showing.
    } finally {
      if (!controller.signal.aborted) {
        setConnecting(false);
      }
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
        <ScreenHeader title={t('common.prReview')} backFallback={ENTRY_HREF} />
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
        <ScreenHeader title={t('common.prReview')} backFallback={ENTRY_HREF} />
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
        <ScreenHeader title={t('common.prReview')} backFallback={ENTRY_HREF} />
        <EmptyState
          icon={revoked ? ShieldAlert : PlugZap}
          title={revoked ? t('prReview.connect.reconnectTitle') : t('common.connectGithub')}
          description={
            <>
              <PrReviewContextLine />
              <Text variant="muted" className="text-center">
                {revoked
                  ? t('prReview.connect.reconnectDescription')
                  : t('prReview.connect.description')}
              </Text>
            </>
          }
          action={
            <Button
              className="mt-3 w-full flex-row gap-2"
              disabled={connecting}
              onPress={() => {
                void handleConnect();
              }}
            >
              <View className="size-4 items-center justify-center">
                {connecting ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <GitHubIcon size={16} color={colors.primaryForeground} />
                )}
              </View>
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
