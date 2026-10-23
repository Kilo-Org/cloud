import { useQuery } from '@tanstack/react-query';
import { PlugZap, RefreshCcw, ShieldAlert } from '@/components/ui/icons';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { CenteredState } from '@/components/centered-state';
import { EmptyState } from '@/components/empty-state';
import { toast } from 'sonner-native';

import { PrReviewContextLine } from '@/components/pr-review/pr-review-context-line';
import { PrReviewGateHeader } from '@/components/pr-review/pr-review-gate-header';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { WEB_BASE_URL } from '@/lib/config';
import { getBitbucketIntegrationUrl, getGitLabIntegrationUrl } from '@/lib/integration-urls';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { launchConnectGateBrowser } from '@/lib/pr-review/connect-gate-platform';
import { selectPrReviewGateView } from '@/lib/pr-review/pr-review-connect-gate-view';
import { type ProviderPrPlatform, useProviderPrScopeOrNull } from '@/lib/pr-review/provider-pr-ref';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

/**
 * The pasted MR URL's origin, when the deep link carried one and it is worth
 * naming: only a self-managed GitLab host differs from the gitlab.com default
 * the reader assumes. Bitbucket Cloud has one host. The hint is display only —
 * the server re-derives the authoritative instance.
 */
function useInstanceHint(platform: ProviderPrPlatform): string | undefined {
  const scope = useProviderPrScopeOrNull();
  const instanceHint =
    platform === 'gitlab' && scope?.ref.platform === 'gitlab' && scope.ref.instanceHint
      ? scope.ref.instanceHint.replace(/\/+$/, '')
      : undefined;
  return instanceHint !== undefined && instanceHint !== 'https://gitlab.com'
    ? instanceHint
    : undefined;
}

/**
 * GitLab / Bitbucket arm. The status query is the s4 integration status the
 * connect flow updates; a Bitbucket personal scope disables it entirely
 * because there is nothing to check — the selector renders the terminal
 * org-only explanation for that case.
 */
export function ProviderConnectGate({
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
  const instanceHint = useInstanceHint(platform);

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

  const [connecting, setConnecting] = useState(false);
  const connectAbort = useRef<AbortController | null>(null);
  useEffect(() => () => connectAbort.current?.abort(), []);

  const handleConnect = async () => {
    const controller = new AbortController();
    connectAbort.current = controller;
    setConnecting(true);
    try {
      // The provider connections are web-side integrations: open the
      // existing integration page and re-check the status when the app
      // returns (pattern: `launchConnectGateBrowser`).
      const integrationUrl =
        platform === 'gitlab'
          ? getGitLabIntegrationUrl(WEB_BASE_URL, organizationId ?? undefined)
          : getBitbucketIntegrationUrl(WEB_BASE_URL, organizationId ?? '');
      await launchConnectGateBrowser(integrationUrl, {
        signal: controller.signal,
        onOpenFailure: () => void toast.error(t('authErrors.couldNotOpenBrowser')),
        onReturn: async () => {
          await status.refetch();
        },
      });
    } catch {
      // The helper reports a failed launch itself, so a rejected `onReturn`
      // refetch is the only error that reaches here. Keep the gate showing:
      // the query's error state renders the retryable
      // QueryError instead of letting `void handleConnect()` reject.
    } finally {
      if (!controller.signal.aborted) {
        setConnecting(false);
      }
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
        <PrReviewGateHeader />
        <EmptyState
          icon={ShieldAlert}
          title={t('agentChat.newSession.bitbucketOrganizationsOnly')}
          description={
            <>
              <PrReviewContextLine />
              <Text variant="muted" className="text-center">
                {t('prReview.connect.bitbucketOrgOnlyDescription')}
              </Text>
            </>
          }
        />
      </View>
    );
  }

  if (view === 'error') {
    return (
      <View className="flex-1 bg-background">
        <PrReviewGateHeader />
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
        <PrReviewGateHeader />
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
        <PrReviewGateHeader />
        <EmptyState
          icon={PlugZap}
          title={title}
          description={
            <>
              <PrReviewContextLine instanceHint={instanceHint} />
              <Text variant="muted" className="text-center">
                {platform === 'gitlab'
                  ? t('prReview.connect.gitlabDescription')
                  : t('prReview.connect.bitbucketDescription')}
              </Text>
            </>
          }
          action={
            <Button
              className={cn('mt-3 w-full flex-row gap-2', STATE_ACTION_CLASS)}
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
