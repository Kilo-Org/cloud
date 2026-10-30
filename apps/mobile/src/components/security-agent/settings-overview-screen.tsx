import { useRouter } from 'expo-router';
import { Bell, Clock, Cpu, FolderGit2, Zap } from '@/components/ui/icons';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AuditReportButton } from '@/components/security-agent/audit-report-button';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { ScreenHeader } from '@/components/screen-header';
import { SettingsOverviewSkeleton } from '@/components/security-agent/settings-overview-skeleton';
import { SettingsRecoveryStatus } from '@/components/security-agent/settings-recovery-status';
import { ToggleRow } from '@/components/security-agent/settings-toggle-row';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import {
  useRetrySecurityAgentSettings,
  useSecurityAgentCapability,
  useSecurityAgentConfig,
  useSecurityAgentRepositories,
  useSetSecurityAgentEnabled,
  useTrackSecurityAgentInteraction,
} from '@/lib/hooks/use-security-agent';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { getSecurityAgentPath } from '@/lib/security-agent';

const ANALYSIS_MODE_KEYS = {
  auto: 'securityAgent.analysisMode.auto',
  shallow: 'securityAgent.analysisMode.shallow',
  deep: 'securityAgent.analysisMode.deep',
};

// The loading state lives in its own module (`settings-overview-skeleton`) so
// the settled screen keeps under the file-length cap.

function getDisabledCopy(canManage: boolean, hasEffectiveRepo: boolean): string {
  if (!canManage) {
    return i18n.t('securityAgent.settingsOverview.disabledNoManage');
  }
  if (!hasEffectiveRepo) {
    return i18n.t('securityAgent.settingsOverview.disabledNoRepo');
  }
  return i18n.t('securityAgent.settingsOverview.disabledPrompt');
}

export function SettingsOverviewScreen({
  scope,
  presentation = 'inline',
  permissionError = false,
}: Readonly<{
  scope: string;
  presentation?: 'inline' | 'route';
  permissionError?: boolean;
}>) {
  const router = useRouter();
  const pushOnce = useSinglePushRoute();
  const { t } = useTranslation();
  const config = useSecurityAgentConfig(scope);
  const capability = useSecurityAgentCapability(scope);
  const isConnectivityKnown = useCommittedConnectivityStatus() !== 'unknown';
  const setEnabled = useSetSecurityAgentEnabled(scope);
  const trackInteraction = useTrackSecurityAgentInteraction(scope);
  const repositories = useSecurityAgentRepositories(scope);
  const recovery = useRetrySecurityAgentSettings(scope);

  // Ref indirection keeps the tracking effect independent of the mutation
  // object's identity (a new object every render) — fires once per mount,
  // mirroring finding-detail-screen.tsx's tracked-once pattern.
  const trackRef = useRef(trackInteraction.mutate);
  trackRef.current = trackInteraction.mutate;
  const trackedRef = useRef(false);

  useEffect(() => {
    if (trackedRef.current) {
      return;
    }
    trackedRef.current = true;
    trackRef.current({ interaction: 'settings_config_viewed' });
  }, []);

  // A successful probe can confirm online while NetInfo still pauses queries.
  const configUnavailable =
    !config.data &&
    (recovery.isRetrying ||
      config.isError ||
      (config.fetchStatus === 'paused' && isConnectivityKnown));
  const capabilityUnavailable =
    capability.status === 'error' ||
    (capability.status === 'loading' &&
      (recovery.isRetrying || (capability.fetchStatus === 'paused' && isConnectivityKnown)));
  const repositoriesLoading = repositories.isLoading || recovery.isRetrying;
  const repositoriesError =
    repositories.isError ||
    (!repositories.data && repositories.fetchStatus === 'paused' && isConnectivityKnown);
  let recoveryError: string | undefined = undefined;
  if (configUnavailable || config.isError) {
    recoveryError = t('securityAgent.settingsOverview.couldNotLoadSettings');
  } else if (capabilityUnavailable || permissionError || capability.isError) {
    recoveryError = t('securityAgent.settingsOverview.couldNotLoadPermissions');
  } else if (repositoriesError) {
    recoveryError = t('common.couldNotLoadRepositories');
  }
  if (configUnavailable || capabilityUnavailable) {
    return (
      <PlatformErrorScreen
        title={t('securityAgent.dashboard.settings')}
        variant={configUnavailable ? 'offline' : 'server'}
        message={recoveryError}
        onRetry={() => void recovery.retry()}
        isRetrying={recovery.isRetrying}
      />
    );
  }
  if (config.isLoading || !config.data || capability.status === 'loading') {
    return <SettingsOverviewSkeleton scope={scope} />;
  }

  const data = config.data;
  // A loading or failed repository query must not read as zero repositories.
  const repositoriesEmpty = repositories.data?.length === 0;
  // Only a settled empty answer names the grant as the next step: a stale `[]`
  // under a failed refetch, or a read still in flight, keeps the recovery
  // status and the generic picker copy instead.
  const repositoriesSettledEmpty = repositoriesEmpty && !repositoriesLoading && !repositoriesError;
  // An enable attempt with no effective repository would be refused by the
  // server, so the switch is disabled up front under the same rule: `selected`
  // mode with zero selected ids, or `all` mode with zero integration repos.
  const hasEffectiveRepo =
    data.repositorySelectionMode === 'all'
      ? (repositories.data?.length ?? 0) > 0
      : data.selectedRepositoryIds.length > 0;
  // A disabled agent with no effective selection is the first-enable deadlock:
  // the switch is disabled (the server would refuse an empty effective set) and
  // the Repositories row only renders when enabled, so offer a direct path to
  // the repo picker. That path must stay reachable when the GitHub App grant is
  // settled and empty — there is nothing to select yet, and widening the grant
  // is the only way out, so hiding the CTA there left the page with no way to
  // grant repositories and no way to turn the agent back on.
  const showRepoCta = !data.isEnabled && capability.canManage && !hasEffectiveRepo;
  let repoCountLabel = t('securityAgent.settingsOverview.repositoriesCount', {
    count: data.selectedRepositoryIds.length,
    displayCount: formatNumber(data.selectedRepositoryIds.length, i18n.language),
  });
  if (data.repositorySelectionMode === 'all') {
    repoCountLabel = t('common.allRepositories');
  }
  const automationEnabledCount = [
    data.autoAnalysisEnabled,
    data.autoRemediationEnabled,
    data.autoDismissEnabled,
  ].filter(Boolean).length;
  const notificationsEnabledCount = [
    data.newFindingNotificationsEnabled,
    data.slaNotificationsEnabled,
  ].filter(Boolean).length;
  const analysisModeLabel = Object.hasOwn(ANALYSIS_MODE_KEYS, data.analysisMode)
    ? t(ANALYSIS_MODE_KEYS[data.analysisMode])
    : data.analysisMode;

  // The haptic on toggle belongs to `ToggleRow`, which owns the press for this
  // row — firing one here too would fire it twice for a single tap.
  const handleToggle = (value: boolean) => {
    // When this screen is the PUSHED settings route (reached from the
    // Dashboard's Settings button), toggling OFF makes the base
    // `[scope]/index` re-derive to `disabled-settings` too — leaving two
    // stacked identical settings pages. Collapse the pushed route on
    // success so Back exits the security-agent section rather than
    // landing on a duplicate. The per-call onSuccess only fires on
    // successful mutation, so the rolled-back error path never navigates.
    const collapseOnSuccess =
      presentation === 'route' && !value
        ? () => {
            if (router.canGoBack()) {
              router.back();
            } else {
              router.dismiss();
            }
          }
        : undefined;
    setEnabled.mutate(
      {
        isEnabled: value,
        repositorySelectionMode: data.repositorySelectionMode,
        selectedRepositoryIds: data.selectedRepositoryIds,
      },
      collapseOnSuccess ? { onSuccess: collapseOnSuccess } : undefined
    );
  };

  // Audit-report access shouldn't depend on the agent being enabled — see
  // the matching header action in scope-entry-screen.tsx, which reaches
  // audit reports from the connected-but-disconnected states. This is the
  // connected-but-disabled counterpart: settings-overview-screen is where
  // scope-entry redirects once the agent is disabled, so the same action
  // needs to be reachable here too.
  const auditAction = capability.canManage ? <AuditReportButton scope={scope} /> : null;

  // Keep progress and Retry visible without hiding cached settings when any
  // settings query fails, even if repositories recover during that attempt.
  const renderRepositoryStatus = () => {
    if (recoveryError || recovery.isRetrying) {
      return (
        <SettingsRecoveryStatus
          message={recoveryError}
          isRetrying={recovery.isRetrying}
          onRetry={() => void recovery.retry()}
        />
      );
    }
    if (repositoriesLoading) {
      return <Skeleton className="h-4 w-56 rounded" />;
    }
    return (
      <Text variant="muted" className="text-xs">
        {getDisabledCopy(capability.canManage, hasEffectiveRepo)}
      </Text>
    );
  };

  // The settings card is a control surface, not an empty state, so it stays
  // top-aligned in both enabled and disabled states — matching the Account
  // settings list and the loading skeleton. Centring it left a large void
  // above the card (explorer security-agent-settings, 2026-09-20).
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        className="px-6"
        title={t('securityAgent.dashboard.settings')}
        // One size-11 (44dp) audit icon; declaring it keeps the one-line
        // title's readable minimum when the row is narrow.
        headerRightWidth={44}
        headerRight={auditAction}
      />
      <TabScreenScrollView className="flex-1">
        <View className="gap-6 px-6 py-4">
          {capability.canManage ? (
            <ToggleRow
              title={t('common.securityAgent')}
              value={data.isEnabled}
              disabled={setEnabled.isPending || (!data.isEnabled && !hasEffectiveRepo)}
              onValueChange={handleToggle}
            />
          ) : (
            <View className="flex-row items-center justify-between rounded-lg bg-secondary p-4">
              <View className="flex-1 pr-3">
                <Text className="text-sm font-medium">{t('common.securityAgent')}</Text>
              </View>
              <Text variant="muted" className="text-xs">
                {data.isEnabled ? t('common.enabled') : t('common.disabled')}
              </Text>
            </View>
          )}

          {(!data.isEnabled || repositoriesLoading || recoveryError) && (
            <View className="gap-3">
              {renderRepositoryStatus()}
              {showRepoCta ? (
                <ConfigureRow
                  icon={FolderGit2}
                  title={t('common.selectRepositories')}
                  // A settled empty grant has nothing to choose from yet, so the
                  // row names the real next step instead of describing a choice
                  // the user cannot make.
                  subtitle={t(
                    repositoriesSettledEmpty
                      ? 'securityAgent.repositories.noRepositoriesDescription'
                      : 'securityAgent.settingsOverview.selectRepositoriesSubtitle'
                  )}
                  onPress={() => {
                    pushOnce(getSecurityAgentPath(scope, 'settings/repositories'));
                  }}
                />
              ) : null}
            </View>
          )}

          {data.isEnabled && (
            <View>
              <ConfigureRow
                icon={FolderGit2}
                title={t('common.repositories')}
                subtitle={repoCountLabel}
                onPress={() => {
                  pushOnce(getSecurityAgentPath(scope, 'settings/repositories'));
                }}
              />
              <ConfigureRow
                icon={Cpu}
                title={t('securityAgent.analysisSettings.title')}
                subtitle={t('securityAgent.settingsOverview.analysisModeSubtitle', {
                  mode: analysisModeLabel,
                })}
                onPress={() => {
                  pushOnce(getSecurityAgentPath(scope, 'settings/analysis'));
                }}
              />
              <ConfigureRow
                icon={Zap}
                title={t('securityAgent.automation.title')}
                subtitle={
                  automationEnabledCount === 0
                    ? t('securityAgent.settingsOverview.automationAllOff')
                    : t('securityAgent.settingsOverview.automationCount', {
                        count: automationEnabledCount,
                        displayCount: formatNumber(automationEnabledCount, i18n.language),
                      })
                }
                onPress={() => {
                  pushOnce(getSecurityAgentPath(scope, 'settings/automation'));
                }}
              />
              <ConfigureRow
                icon={Bell}
                title={t('common.notifications')}
                subtitle={
                  notificationsEnabledCount === 0
                    ? t('common.off')
                    : t('securityAgent.settingsOverview.notificationsCount', {
                        count: notificationsEnabledCount,
                        displayCount: formatNumber(notificationsEnabledCount, i18n.language),
                      })
                }
                onPress={() => {
                  pushOnce(getSecurityAgentPath(scope, 'settings/notifications'));
                }}
              />
              <ConfigureRow
                icon={Clock}
                title={t('securityAgent.sla.title')}
                subtitle={
                  data.slaEnabled ? t('securityAgent.settingsOverview.on') : t('common.off')
                }
                last
                onPress={() => {
                  pushOnce(getSecurityAgentPath(scope, 'settings/sla'));
                }}
              />
            </View>
          )}
        </View>
      </TabScreenScrollView>
    </View>
  );
}
