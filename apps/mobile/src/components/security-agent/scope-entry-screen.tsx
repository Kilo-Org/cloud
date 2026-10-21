import { isPersonalSecurityScope } from '@kilocode/app-shared/security-agent';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AuditReportButton } from '@/components/security-agent/audit-report-button';
import { selectScopeEntryView } from '@/components/security-agent/scope-entry-render';
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
import { useOrganizationScopeAccess } from '@/lib/hooks/use-organization-scope-access';

function ScopeEntrySkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.securityAgent')} />
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
  const permission = useSecurityAgentPermissionStatus(scope);
  const config = useSecurityAgentConfig(scope);
  const repositories = useSecurityAgentRepositories(scope);
  const capability = useSecurityAgentCapability(scope);
  const recovery = useRetrySecurityAgentSettings(scope);
  const isConnectivityKnown = useCommittedConnectivityStatus() !== 'unknown';
  const access = useOrganizationScopeAccess(isPersonalSecurityScope(scope) ? undefined : scope, [
    permission.error,
    config.error,
    repositories.error,
  ]);

  // Pending includes uncached queries paused by NetInfo. Cached query errors
  // must not replace usable settings or a resolved capability with an error screen.
  const isLoading = permission.isPending || config.isPending || capability.status === 'loading';
  const isError =
    (!permission.data && permission.isError) ||
    (!config.data && config.isError) ||
    capability.status === 'error';
  const isPaused =
    permission.fetchStatus === 'paused' ||
    config.fetchStatus === 'paused' ||
    capability.fetchStatus === 'paused';

  const hasIntegration = permission.data?.hasIntegration ?? false;
  const hasPermissions = permission.data?.hasPermissions ?? false;
  const isEnabled = config.data?.isEnabled ?? false;

  const view = selectScopeEntryView({
    isLoading,
    isError,
    isDenied: access !== 'granted',
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

  if (view === 'denied') {
    return (
      <ScopeAccessDeniedScreen
        title={t('common.securityAgent')}
        kind={access === 'not-found' ? 'not-found' : 'denied'}
        onRetry={() => void recovery.retry()}
        isRetrying={recovery.isRetrying}
      />
    );
  }

  if (
    view === 'error' ||
    (isLoading && (isError || recovery.isRetrying || (isPaused && isConnectivityKnown)))
  ) {
    return (
      <PlatformErrorScreen
        title={t('common.securityAgent')}
        errorTitle={t('securityAgent.scopeEntry.couldNotLoad')}
        onRetry={() => void recovery.retry()}
        isRetrying={recovery.isRetrying}
      />
    );
  }

  if (view === 'loading') {
    return <ScopeEntrySkeleton />;
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
          <ScreenHeader title={t('common.securityAgent')} headerRight={auditAction} />
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
          <ScreenHeader title={t('common.securityAgent')} headerRight={auditAction} />
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
      // Fade the Dashboard in when the agent is enabled: the
      // `disabled-settings` branch's <SettingsOverviewScreen> unmounts in
      // place once `config.isEnabled` flips true, which is otherwise an
      // abrupt snap. Only the incoming subtree is wrapped — the loading,
      // error, and setup branches above must stay snap-instant so they
      // feel like real state changes, not animations.
      return (
        <Animated.View entering={FadeIn.duration(200)} className="flex-1">
          <DashboardScreen scope={scope} />
        </Animated.View>
      );
    }
    default: {
      throw new Error('Unexpected scope entry view');
    }
  }
}
