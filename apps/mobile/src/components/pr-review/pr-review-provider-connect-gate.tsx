import { useQuery } from '@tanstack/react-query';
import { PlugZap, RefreshCcw, ShieldAlert } from '@/components/ui/icons';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { CenteredState } from '@/components/centered-state';
import { EmptyState } from '@/components/empty-state';
import { toast } from 'sonner-native';

import { PrReviewContextLine } from '@/components/pr-review/pr-review-context-line';
import { PrReviewGateHeader } from '@/components/pr-review/pr-review-gate-header';
import { PrReviewGateItemLine } from '@/components/pr-review/pr-review-gate-item-line';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { PERSONAL_SCOPE } from '@/lib/code-reviewer-config';
import { WEB_BASE_URL } from '@/lib/config';
import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { useReviewerPermission } from '@/lib/hooks/use-reviewer-permission';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getBitbucketIntegrationUrl, getGitLabIntegrationUrl } from '@/lib/integration-urls';
import { useOrganization } from '@/lib/organization-context';
import { launchConnectGateBrowser } from '@/lib/pr-review/connect-gate-platform';
import {
  PR_REVIEW_GATE_ICON_TILE_CLASS,
  usePrReviewGateIconColor,
} from '@/lib/pr-review/pr-review-gate-illustration';
import {
  gitlabInstanceMismatch,
  selectPrReviewConnectAction,
  selectPrReviewGateView,
} from '@/lib/pr-review/pr-review-connect-gate-view';
import {
  type ProviderPrPlatform,
  type ProviderPrRef,
  useProviderPrScopeOrNull,
} from '@/lib/pr-review/provider-pr-ref';
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
 * The one line under the Bitbucket organization-only explanation. It names the
 * account switch only when the memberships answer says there is somewhere to
 * switch to, and says so plainly when the account belongs to no organization.
 * A failed read gets no line of its own: the context line above already reports
 * the failure with a retry, and neither wording is true of an unknown list.
 */
function OrgOnlyDescription({
  membershipsError,
  organizationCount,
}: Readonly<{
  membershipsError: boolean;
  /** Undefined until the memberships answer lands. */
  organizationCount: number | undefined;
}>) {
  const { t } = useTranslation();
  if (membershipsError) {
    return null;
  }
  return (
    <Text variant="muted" className="text-center">
      {organizationCount === 0
        ? t('prReview.connect.bitbucketOrgOnlyNoOrganizationDescription')
        : t('prReview.connect.bitbucketOrgOnlyDescription')}
    </Text>
  );
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
  prRef,
  children,
}: Readonly<{
  platform: Exclude<ProviderPrPlatform, 'github'>;
  organizationId: string | null;
  /** The PR/MR the route opened; see `PrReviewGateItemLine`. */
  prRef?: ProviderPrRef;
  children: ReactNode;
}>) {
  const trpc = useTRPC();
  const colors = useThemeColors();
  const iconColor = usePrReviewGateIconColor();
  const { t } = useTranslation();
  const instanceHint = useInstanceHint(platform);
  // The org-only arm sends a personal reader to the account switch above. That
  // switch is the context line's, and it exists only when the reader has a
  // membership — so the memberships answer decides which copy is true. One
  // cache entry serves this and the context line; nothing refetches.
  const memberships = useOrganizationsList();
  // The connect CTA opens the web integration page, which refuses some
  // organization roles for some providers (see `selectPrReviewConnectAction`).
  // Read the caller's role the way the code-reviewer screens do, from the same
  // cached memberships answer.
  const permission = useReviewerPermission(organizationId ?? PERSONAL_SCOPE);
  // Whether the stored account selection has been restored. Until it has, the
  // `organizationId` prop is null even for a reader whose organization is being
  // restored, so the gate must not answer for the personal scope yet.
  const organization = useOrganization();
  // The restore reports a failure through `error` without ever reporting
  // `isLoaded`, so its failure is the other settled signal — otherwise the gate
  // would wait for a selection that will never arrive. And a restore re-runs on
  // a token change, briefly reporting the selection as unrestored again, so
  // once it has landed this keeps that answer: the review subtree must not be
  // replaced by the spinner under a reader who is already reviewing.
  //
  // The latch is state, adjusted synchronously during render (React's "adjust
  // state when props change" pattern, as in `agents/markdown-image.tsx`): a
  // render React discards drops the adjustment with it, and the re-render it
  // schedules happens before the selector below runs, so no frame shows the
  // spinner for a selection that has already landed.
  const selectionSettledNow = organization.isLoaded || organization.error !== null;
  const [selectionSettled, setSelectionSettled] = useState(selectionSettledNow);
  if (selectionSettledNow && !selectionSettled) {
    setSelectionSettled(true);
  }

  // The providers — and the two GitLab scopes, whose payloads now differ by
  // the personal reconnect marker — answer with different status shapes, so
  // each arm subscribes to its own query and only one is enabled per mount: a
  // union of two queryOptions types is not assignable to one useQuery.
  const personalGitlabStatus = useQuery({
    ...trpc.personalReviewAgent.getGitLabStatus.queryOptions(),
    enabled: platform === 'gitlab' && organizationId === null,
  });
  const organizationGitlabStatus = useQuery({
    ...trpc.organizations.reviewAgent.getGitLabStatus.queryOptions({
      organizationId: organizationId ?? '',
    }),
    enabled: platform === 'gitlab' && organizationId !== null,
  });
  // Bitbucket Cloud is organization-context only (s4): with no organization
  // selected there is no endpoint to ask, so the query stays disabled and the
  // gate renders the org-only explanation.
  const bitbucketStatus = useQuery({
    ...trpc.organizations.reviewAgent.getBitbucketReadiness.queryOptions({
      organizationId: organizationId ?? '',
    }),
    enabled: platform === 'bitbucket' && organizationId !== null,
  });
  const gitlabStatus = organizationId ? organizationGitlabStatus : personalGitlabStatus;
  const status = platform === 'gitlab' ? gitlabStatus : bitbucketStatus;

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
        onReturn: () => {
          // Detached on purpose: the browser closing is the user's edge, so the
          // CTA returns to idle as soon as it happens. A status read that stays
          // pending (the default `networkMode: 'online'` never settles while the
          // online manager reports offline) must not keep Connect disabled — the
          // read's own states carry the outcome, and a real failure renders the
          // retryable QueryError below.
          void status.refetch().catch(() => undefined);
          return Promise.resolve();
        },
      });
    } catch {
      // `launchConnectGateBrowser` reports a failed launch through
      // `onOpenFailure`; this keeps `void handleConnect()` from rejecting if the
      // refresh helper throws before that. The status read's own error state
      // renders the retryable QueryError.
    } finally {
      if (!controller.signal.aborted) {
        setConnecting(false);
      }
    }
  };

  // A GitLab connection serves exactly one instance, and the status read names
  // it. When the opened merge request lives on another host the server refuses
  // every read as not-found (its own origin guard), so `connected` alone is not
  // the answer — the mismatch decides the gate.
  const instanceMismatch =
    platform === 'gitlab'
      ? gitlabInstanceMismatch({
          instanceHint,
          connectedInstanceUrl: gitlabStatus.data?.integration?.instanceUrl,
        })
      : null;

  const view = selectPrReviewGateView({
    platform,
    isError: status.isError,
    isLoading: status.isPending,
    connected: status.data?.connected === true,
    // Both GitLab scopes distinguish an existing connection that needs
    // re-authorizing from a first-time connect: the personal and the
    // organization status reads each report the marker for their own row.
    reconnectRequired:
      platform === 'gitlab' ? gitlabStatus.data?.reconnectRequired === true : false,
    instanceMismatch: instanceMismatch !== null,
    organizationId,
    // The layout hands this gate `useOrganization()`'s value, so the two agree
    // on when the stored selection has landed. Reading it here too keeps the
    // gate from asking the personal scope for an organization reader's first
    // answer.
    organizationSelectionLoaded: selectionSettled,
  });

  if (view === 'org-only') {
    // Only claim there is nowhere to go once the memberships answer says so;
    // until it lands, keep the guidance the common case with an organization
    // can act on. A failed read is neither case: the context line already
    // reports it with a retry, and neither wording is true, so the gate adds
    // no second description over an account line it cannot vouch for.
    return (
      <View className="flex-1 bg-background">
        <PrReviewGateHeader />
        <EmptyState
          icon={ShieldAlert}
          iconContainerClassName={PR_REVIEW_GATE_ICON_TILE_CLASS}
          iconColor={iconColor}
          title={t('agentChat.newSession.bitbucketOrganizationsOnly')}
          description={
            <>
              <PrReviewGateItemLine prRef={prRef} />
              {/* The switcher stays above this arm's explanation: its copy tells
                  the reader to switch "the account above", so the control has to
                  be the line they read first. */}
              <PrReviewContextLine />
              <OrgOnlyDescription
                membershipsError={memberships.isError}
                organizationCount={memberships.data?.length}
              />
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

  if (view === 'connect' || view === 'reconnect' || view === 'instance-mismatch') {
    const reconnect = view === 'reconnect';
    // The mismatch arm lists in `instance-mismatch`: the connection is live,
    // on another instance than the opened merge request, so no read can
    // succeed and nothing about the item is being claimed.
    const mismatch = view === 'instance-mismatch' ? instanceMismatch : null;
    // The mismatch CTA opens the integration page for an owner that already has
    // a GitLab row, so it answers to the same role rule as a re-authorization.
    const action = selectPrReviewConnectAction({
      platform,
      view: view === 'instance-mismatch' ? 'reconnect' : view,
      organizationId,
      canManageOrganizationBilling: permission.status === 'ready' ? permission.canEdit : null,
    });
    // Reused translated copy: the title above already names the expired
    // provider connection, so the description carries only the re-check
    // instruction and never restates the title. One key serves both the
    // provider gate and the mid-session notice, so the two surfaces cannot
    // drift apart.
    //
    // The first-time connect description is the benefit alone, never a second
    // "Connect your … account": the title and the CTA already say that, and the
    // context line above names the scope. GitHub and Bitbucket review pull
    // requests, so both arms share one key; GitLab names merge requests.
    const connectTitle =
      platform === 'gitlab' ? t('common.connectGitlab') : t('common.connectBitbucket');
    const connectDescription =
      platform === 'gitlab'
        ? t('prReview.connect.gitlabDescription')
        : t('common.prReviewSubtitle');
    const reconnectTitle =
      platform === 'gitlab'
        ? t('prReview.reconnectNotice.gitlabTitle')
        : t('prReview.reconnectNotice.bitbucketTitle');
    let title = reconnect ? reconnectTitle : connectTitle;
    let description = connectDescription;
    if (reconnect) {
      // The title above already names the expired provider connection, so the
      // description carries only the re-check instruction and never restates
      // the title. One key serves both the provider gate and the mid-session
      // notice, so the two surfaces cannot drift apart.
      description = t('prReview.reconnectNotice.message');
    }
    if (mismatch) {
      // The mismatch description names both hosts, because they are the whole
      // difference the reader has to act on and both are the account's own
      // data: the status read that supplied one belongs to the same reader.
      title = t('prReview.connect.gitlabInstanceMismatchTitle');
      description = t('prReview.connect.gitlabInstanceMismatchDescription', {
        connected: mismatch.connectedHost,
        requested: mismatch.requestedHost,
      });
    }
    if (action === 'organization-admin-only' && mismatch === null) {
      // The reader cannot complete the integration page's action from this
      // role, so the state names the roles that can and carries no action. An
      // expired GitLab connection keeps its title and asks for a reconnection;
      // an absent Bitbucket connection cannot make the connect call its title
      // no longer offers, so that title states the absence instead.
      if (platform === 'gitlab') {
        description = t('prReview.connect.gitlabReconnectAdminOnlyDescription');
      } else {
        title = t('prReview.connect.bitbucketNotConnectedTitle');
        description = t('prReview.connect.bitbucketAdminOnlyDescription');
      }
    }
    return (
      <View className="flex-1 bg-background">
        <PrReviewGateHeader />
        <EmptyState
          icon={reconnect || mismatch ? ShieldAlert : PlugZap}
          iconContainerClassName={PR_REVIEW_GATE_ICON_TILE_CLASS}
          iconColor={iconColor}
          title={title}
          description={
            <>
              <PrReviewGateItemLine prRef={prRef} />
              <Text variant="muted" className="text-center">
                {description}
              </Text>
              {/* An organization member who cannot complete the action still
                  needs to know whose action it is, under the explanation of
                  why the connection does not fit. */}
              {action === 'organization-admin-only' && mismatch !== null ? (
                <Text variant="muted" className="text-center">
                  {t('prReview.connect.gitlabReconnectAdminOnlyDescription')}
                </Text>
              ) : null}
              {/* The mismatch copy already names the requested host, so the
                  context line keeps naming only the scope. */}
              <PrReviewContextLine
                instanceHint={mismatch === null ? instanceHint : undefined}
                className="mt-3"
              />
            </>
          }
          action={
            action === 'connect' ? (
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
                <Text>{connectTitle}</Text>
              </Button>
            ) : undefined
          }
        />
      </View>
    );
  }

  return <>{children}</>;
}
