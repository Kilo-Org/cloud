import { isPersonalSecurityScope } from '@kilocode/app-shared/security-agent';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AuditReportButton } from '@/components/security-agent/audit-report-button';
import {
  selectScopeEntryLoadFailure,
  selectScopeEntryView,
} from '@/components/security-agent/scope-entry-render';
import { ScopeAccessDeniedScreen } from '@/components/organization/scope-access-denied-screen';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { ScreenHeader } from '@/components/screen-header';
import { DashboardScreen } from '@/components/security-agent/dashboard-screen';
import { SecurityAgentSetup } from '@/components/security-agent/security-agent-setup';
import { SettingsOverviewScreen } from '@/components/security-agent/settings-overview-screen';
import { Skeleton } from '@/components/ui/skeleton';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { WEB_BASE_URL } from '@/lib/config';
import { trpcClient } from '@/lib/trpc';
import {
  useRetrySecurityAgentSettings,
  useSecurityAgentCapability,
  useSecurityAgentConfig,
  useSecurityAgentPermissionStatus,
  useSecurityAgentRepositories,
} from '@/lib/hooks/use-security-agent';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useSecurityScopeTitle } from '@/lib/hooks/use-security-scope-title';
import { classifyOrganizationScopeAccess } from '@/lib/organization-scope-access';

function ScopeEntrySkeleton({ scope }: Readonly<{ scope: string }>) {
  const { t } = useTranslation();
  const scopeTitle = useSecurityScopeTitle(scope);
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        className="px-6"
        title={scopeTitle}
        eyebrow={t('common.securityAgent')}
        titleNumberOfLines={2}
      />
      <View className="gap-3 px-6 pt-4">
        <Skeleton className="h-10 w-full rounded-lg" />
        <View className="flex-row flex-wrap gap-3">
          <Skeleton className="h-24 w-[47%] rounded-lg" />
          <Skeleton className="h-24 w-[47%] rounded-lg" />
          <Skeleton className="h-24 w-[47%] rounded-lg" />
          <Skeleton className="h-24 w-[47%] rounded-lg" />
        </View>
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </View>
    </View>
  );
}

export function ScopeEntryScreen({ scope }: Readonly<{ scope: string }>) {
  const { t } = useTranslation();
  const scopeTitle = useSecurityScopeTitle(scope);
  const permission = useSecurityAgentPermissionStatus(scope);
  const config = useSecurityAgentConfig(scope);
  const repositories = useSecurityAgentRepositories(scope);
  const capability = useSecurityAgentCapability(scope);
  const recovery = useRetrySecurityAgentSettings(scope);
  const connectivity = useCommittedConnectivityStatus();
  const isConnectivityKnown = connectivity !== 'unknown';
  const access = classifyOrganizationScopeAccess({
    isOrganizationScope: !isPersonalSecurityScope(scope),
    errors: [permission.error, config.error, repositories.error],
  });

  // The config decides the destination. Once it is cached its owner is known,
  // so the GitHub status and role reads only refine the setup gates and the
  // controls — a pending, paused or failed one must not replace a destination
  // that renders fine. Those reads are still fatal while the config itself is
  // unread, or while the setup gates genuinely depend on them (agent disabled).
  const configSettled = config.data !== undefined;
  const isEnabledResolved = config.data?.isEnabled ?? false;
  const isGithubStatusResolved = permission.data !== undefined;
  // Only a status read that failed without a value is a failure of this screen.
  const isGithubStatusUnknown = !isGithubStatusResolved && permission.isError;
  const isConfigUnread = !config.data && config.isError;
  const isLoading =
    config.isPending ||
    (!isEnabledResolved && (permission.isPending || capability.status === 'loading'));
  const isError = configSettled
    ? !isEnabledResolved && (isGithubStatusUnknown || capability.status === 'error')
    : isConfigUnread || capability.status === 'error' || permission.isError;
  const isPaused =
    permission.fetchStatus === 'paused' ||
    config.fetchStatus === 'paused' ||
    capability.fetchStatus === 'paused';

  const hasIntegration = permission.data?.hasIntegration ?? false;
  const hasPermissions = permission.data?.hasPermissions ?? false;
  const isEnabled = isEnabledResolved;

  const view = selectScopeEntryView({
    isLoading,
    isError,
    isDenied: access !== 'granted',
    isGithubStatusResolved,
    hasIntegration,
    hasPermissions,
    isEnabled,
  });

  // Pre-mint a C1 install state token so the web /github-app page
  // receives it and does not mint a second token.  The return path is
  // /cloud/sessions — a claimed universal-link route that maps to the
  // agents tab.
  const orgId = isPersonalSecurityScope(scope) ? undefined : scope;
  const [mintUrl, setMintUrl] = useState<string | null>(null);
  const [isMinting, setIsMinting] = useState(false);
  const cancelledRef = useRef(false);
  const mintUrlRef = useRef<string | null>(null);

  // A failed mint must not replace the setup screen with an error-only page:
  // the setup state (with the audit-report action) stays usable and the press
  // retries the mint before opening. The mount-time mint (`isInitial`) clears
  // any previous URL and drives the skeleton; a press-time re-mint leaves the
  // setup mounted — its own connecting spinner covers the wait, and unmounting
  // it would drop that state mid-press. Resolves to whether a URL is
  // available afterwards so the button handler can open immediately.
  const performMint = useCallback(
    async (isInitial = false): Promise<boolean> => {
      if (isInitial) {
        setMintUrl(null);
        mintUrlRef.current = null;
        setIsMinting(true);
      }
      try {
        const { token } = await trpcClient.githubApps.mintInstallState.mutate({
          organizationId: orgId ?? undefined,
          returnTo: '/cloud/sessions',
        });
        const url = getGitHubIntegrationUrl(WEB_BASE_URL, orgId, token);
        mintUrlRef.current = url;
        if (!cancelledRef.current) {
          setMintUrl(url);
        }
        return true;
      } catch {
        return false;
      } finally {
        if (isInitial && !cancelledRef.current) {
          setIsMinting(false);
        }
      }
    },
    [orgId]
  );

  const reauthUrl = permission.data?.reauthorizeUrl;

  // Mint only when the entry view actually needs a fresh GitHub install URL:
  // connect-github always, reauthorize only when the server offered no
  // reauthorize URL. Dashboard and disabled-settings mounts must not mint —
  // the token is a bearer credential and churning it on every visit is
  // wasteful.
  const shouldMint = view === 'connect-github' || (view === 'reauthorize' && !reauthUrl);

  useEffect(() => {
    cancelledRef.current = false;
    if (shouldMint) {
      void performMint(true);
    }
    return () => {
      cancelledRef.current = true;
    };
  }, [performMint, shouldMint]);

  // Never fall back to an unminted URL — an app-initiated open must carry a
  // pre-minted token or the connect action must fail closed.
  const connectUrl = mintUrl;

  const refetchAll = recovery.retry;
  const { clearLastAttemptFailed } = recovery;

  // A recorded failure describes the error episode that produced it. Clearing
  // it on any other view keeps a later, unrelated failure from claiming that
  // the reader's last retry is what failed.
  useEffect(() => {
    if (view !== 'error') {
      clearLastAttemptFailed();
    }
  }, [view, clearLastAttemptFailed]);

  if (view === 'denied') {
    return (
      <ScopeAccessDeniedScreen
        title={scopeTitle}
        eyebrow={t('common.securityAgent')}
        kind={access === 'not-found' ? 'not-found' : 'denied'}
        onRetry={() => void recovery.retry()}
        isRetrying={recovery.isRetrying}
      />
    );
  }

  // A settled, enabled config already names the destination, so a paused or
  // failing secondary read only delays its chrome and must never replace it.
  // Without that destination the setup gates do depend on those reads, so a
  // paused one stays the retriable failure it describes.
  const isDestinationKnown = configSettled && isEnabledResolved;
  const isLoadFailureView =
    view === 'error' ||
    (!isDestinationKnown && isLoading && (isError || (isPaused && isConnectivityKnown)));

  if (isLoadFailureView) {
    // A retry in flight must be visible: the failure screen is swapped for the
    // loading skeleton, so progress does not depend on a text-less button
    // spinner. The screen the retry returns to names the cause of the latest
    // failure: a connection cause adds the retry-failed wording, while a server
    // answer keeps the server wording, so that frame can repeat the one the tap
    // started from. A retry that resolves the other reads still lands on their
    // own view, as before.
    if (recovery.isRetrying) {
      return <ScopeEntrySkeleton scope={scope} />;
    }
    // Only the reads that produced this screen carry the cause. A read that
    // still holds cached data, or that resolved, must not vote on it.
    const failedReads: unknown[] = [];
    if (isConfigUnread) {
      failedReads.push(config.error);
    }
    if (capability.status === 'error') {
      failedReads.push(capability.error);
    }
    if (isGithubStatusUnknown) {
      failedReads.push(permission.error);
    }
    const failure = selectScopeEntryLoadFailure({
      errors: failedReads,
      isPaused,
      connectivity,
      lastAttemptFailed: recovery.lastAttemptFailed,
    });
    return (
      <PlatformErrorScreen
        title={scopeTitle}
        eyebrow={t('common.securityAgent')}
        errorTitle={t('securityAgent.scopeEntry.couldNotLoad')}
        variant={failure.variant}
        message={failure.descriptionKey ? t(failure.descriptionKey) : undefined}
        onRetry={() => void recovery.retry()}
      />
    );
  }

  if (view === 'loading') {
    return <ScopeEntrySkeleton scope={scope} />;
  }

  // Audit-report access shouldn't depend on the agent being connected or
  // enabled — it's a link to historical reports, not agent-managed UI — so
  // it's offered here in the shared shell, ahead of the setup/disabled
  // gates below, whenever the caller can manage the agent.
  const auditAction = capability.canManage ? <AuditReportButton scope={scope} /> : null;

  switch (view) {
    case 'connect-github': {
      // A failed or pending mount-time mint keeps this setup screen up; the
      // button resolves (re-mints) the URL on press. An error-only page here
      // made the landing permanently unusable on a transient backend failure.
      return (
        <View className="flex-1 bg-background">
          <ScreenHeader
            className="px-6"
            title={scopeTitle}
            eyebrow={t('common.securityAgent')}
            titleNumberOfLines={2}
            headerRight={auditAction}
          />
          {!connectUrl && isMinting ? (
            <View className="gap-3 px-6 pt-4">
              <Skeleton className="h-10 w-full rounded-lg" />
              <Skeleton className="h-32 w-full rounded-lg" />
            </View>
          ) : (
            <SecurityAgentSetup
              title={t('securityAgent.scopeEntry.connectTitle')}
              description={t('securityAgent.scopeEntry.connectDescription')}
              buttonLabel={t('securityAgent.scopeEntry.installApp')}
              url={connectUrl ?? undefined}
              resolveUrl={async () => {
                const minted = await performMint();
                return minted ? (mintUrlRef.current ?? undefined) : undefined;
              }}
              onConnected={refetchAll}
            />
          )}
        </View>
      );
    }
    case 'reauthorize': {
      // Same contract as connect-github: the reauthorize setup stays up when
      // the server offered no URL and the mount-time mint failed; the button
      // re-mints on press.
      return (
        <View className="flex-1 bg-background">
          <ScreenHeader
            className="px-6"
            title={scopeTitle}
            eyebrow={t('common.securityAgent')}
            titleNumberOfLines={2}
            headerRight={auditAction}
          />
          {!reauthUrl && !connectUrl && isMinting ? (
            <View className="gap-3 px-6 pt-4">
              <Skeleton className="h-10 w-full rounded-lg" />
              <Skeleton className="h-32 w-full rounded-lg" />
            </View>
          ) : (
            <SecurityAgentSetup
              title={t('securityAgent.scopeEntry.reauthorizeTitle')}
              description={t('securityAgent.scopeEntry.reauthorizeDescription')}
              buttonLabel={t('securityAgent.scopeEntry.reauthorizeButton')}
              url={reauthUrl ?? connectUrl ?? undefined}
              resolveUrl={async () => {
                if (reauthUrl) {
                  return reauthUrl;
                }
                const minted = await performMint();
                return minted ? (mintUrlRef.current ?? undefined) : undefined;
              }}
              onConnected={refetchAll}
            />
          )}
        </View>
      );
    }
    case 'disabled-settings': {
      return (
        <SettingsOverviewScreen
          scope={scope}
          presentation="inline"
          permissionError={permission.isError}
        />
      );
    }
    case 'dashboard': {
      // No entrance animation: a Reanimated `FadeIn` carries
      // `initialValues: { opacity: 0 }`, so a first mount whose entrance is
      // dropped or never started leaves this whole subtree — the header
      // included — invisible at opacity 0, and only the tab bar outside the
      // screen paints. The dashboard (and its header) must paint in the frame
      // the enabled view resolves.
      return (
        <View className="flex-1">
          <DashboardScreen scope={scope} />
        </View>
      );
    }
    default: {
      throw new Error('Unexpected scope entry view');
    }
  }
}
