import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlugZap, ShieldAlert } from '@/components/ui/icons';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { usePathname } from 'expo-router';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { GitHubIcon } from '@/components/icons/github-icon';
import { PrReviewGateActionGroup } from '@/components/pr-review/pr-review-gate-action-group';
import { PrReviewGateHeader } from '@/components/pr-review/pr-review-gate-header';
import { PrReviewGateItemLine } from '@/components/pr-review/pr-review-gate-item-line';
import { PrReviewGateLoading } from '@/components/pr-review/pr-review-gate-loading';
import { ProviderConnectGate } from '@/components/pr-review/pr-review-provider-connect-gate';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { launchConnectGateBrowser } from '@/lib/pr-review/connect-gate-platform';
import {
  PR_REVIEW_GATE_ICON_TILE_CLASS,
  usePrReviewGateIconColor,
} from '@/lib/pr-review/pr-review-gate-illustration';
import { selectPrReviewGateView } from '@/lib/pr-review/pr-review-connect-gate-view';
import { type ProviderPrPlatform, type ProviderPrRef } from '@/lib/pr-review/provider-pr-ref';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

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
  /**
   * The PR/MR the route opened, when it names one. The gate prints it above
   * the account line so the reader can tell which item they are connecting
   * for; a mount with no known item (the entry route) keeps the generic copy.
   */
  readonly prRef?: ProviderPrRef;
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
 *  - reconnect: the connection exists but can no longer be used (GitHub
 *    revoked, or a personal GitLab row whose credential the token service
 *    refuses) → re-authorize copy and the same integration-page CTA
 *  - non-retryable: Bitbucket personal → org-only explanation, no CTA
 *
 * The entry screen is provider-neutral — a pasted GitLab or Bitbucket link
 * must work for a user with no GitHub connection — so the gate is a
 * pass-through there; the provider gates protect each detail route.
 *
 * The GitHub CTA calls `githubApps.connectUserAuthorization` and opens the
 * returned URL with the shared auth-session launcher. Backing out of the sign-in
 * sheet returns the CTA to idle so the user can retry, on both platforms; there
 * is nothing to roll back because the auth flow is server-driven, and the status
 * re-check runs without holding the CTA.
 */
export function PrReviewConnectGate({
  children,
  platform = 'github',
  organizationId = null,
  prRef,
}: PrReviewConnectGateProps) {
  const pathname = usePathname();
  // The entry route (`(app)/pr-review` → pathname `/pr-review`) is the one
  // PR-review surface that serves all three providers at once; gating it on
  // any single connection would lock out the other two.
  if (pathname === '/pr-review') {
    return <>{children}</>;
  }
  if (platform === 'github') {
    return <GitHubConnectGate prRef={prRef}>{children}</GitHubConnectGate>;
  }
  return (
    <ProviderConnectGate platform={platform} organizationId={organizationId} prRef={prRef}>
      {children}
    </ProviderConnectGate>
  );
}

function GitHubConnectGate({
  children,
  prRef,
}: Readonly<{ children: ReactNode; prRef?: ProviderPrRef }>) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const iconColor = usePrReviewGateIconColor();
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
    // A retry supersedes the attempt still waiting: abort it first, so its late
    // report cannot speak for this one.
    connectAbort.current?.abort();
    const controller = new AbortController();
    connectAbort.current = controller;
    setConnecting(true);
    try {
      const result = await connect.mutateAsync();
      await launchConnectGateBrowser(result.authorizationUrl, {
        signal: controller.signal,
        onOpenFailure: () => void toast.error(t('authErrors.couldNotOpenBrowser')),
        onReturn: () => {
          // Detached on purpose: the sheet closing is the user's edge, so the
          // CTA returns to idle as soon as it happens. A status read that stays
          // pending (the default `networkMode: 'online'` never settles while the
          // online manager reports offline) must not keep Connect disabled — the
          // read's own states carry the outcome, and a real failure renders the
          // retryable QueryError below.
          void authorization
            .refetch()
            .then(() =>
              queryClient.invalidateQueries({
                queryKey: trpc.githubApps.getUserAuthorization.queryKey(),
              })
            )
            .catch(() => undefined);
          return Promise.resolve();
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
    reconnectRequired: authorization.data?.revoked === true,
    // GitHub has one host and no per-instance connection to mismatch.
    instanceMismatch: false,
    organizationId: null,
    // The GitHub connect is the caller's own account authorization, identical
    // with or without an organization selected, so it never waits on that
    // selection.
    organizationSelectionLoaded: true,
  });

  if (view === 'error') {
    return (
      <View className="flex-1 bg-background">
        <PrReviewGateHeader />
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
    return <PrReviewGateLoading />;
  }

  if (view === 'connect' || view === 'reconnect') {
    const revoked = view === 'reconnect';
    return (
      <View className="flex-1 bg-background">
        <PrReviewGateHeader />
        <EmptyState
          icon={revoked ? ShieldAlert : PlugZap}
          iconContainerClassName={PR_REVIEW_GATE_ICON_TILE_CLASS}
          iconColor={iconColor}
          title={revoked ? t('prReview.connect.reconnectTitle') : t('common.connectGithub')}
          description={
            <>
              <PrReviewGateItemLine prRef={prRef} />
              <Text variant="muted" className="text-center">
                {/* The benefit line, not a second "Connect your GitHub account":
                    the title and the CTA already name the action, and the item
                    and scope lines above give the context. The reconnect arm's
                    key states the cause only, for the same reason. */}
                {revoked
                  ? t('prReview.connect.reconnectDescription')
                  : t('common.prReviewSubtitle')}
              </Text>
            </>
          }
          action={
            <PrReviewGateActionGroup>
              <Button
                className={cn('w-full flex-row gap-2', STATE_ACTION_CLASS)}
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
            </PrReviewGateActionGroup>
          }
        />
      </View>
    );
  }

  return <>{children}</>;
}
