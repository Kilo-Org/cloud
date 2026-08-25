import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Bell, Clock, Cpu, FolderGit2, Zap } from '@/components/ui/icons';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch, View } from 'react-native';

import { AuditReportButton } from '@/components/security-agent/audit-report-button';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { i18n } from '@/i18n';
import {
  useSecurityAgentCapability,
  useSecurityAgentConfig,
  useSecurityAgentRepositories,
  useSetSecurityAgentEnabled,
  useTrackSecurityAgentInteraction,
} from '@/lib/hooks/use-security-agent';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { capitalize } from '@/lib/utils';

function SettingsOverviewSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('securityAgent.settingsOverview.title')} />
      <View className="gap-3 px-6 pt-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
      </View>
    </View>
  );
}

type SettingsOverviewPresentation = 'inline' | 'route';

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
}: Readonly<{ scope: string; presentation?: SettingsOverviewPresentation }>) {
  const router = useRouter();
  const { t } = useTranslation();
  const config = useSecurityAgentConfig(scope);
  const capability = useSecurityAgentCapability(scope);
  const committedConnectivity = useCommittedConnectivityStatus();
  const setEnabled = useSetSecurityAgentEnabled(scope);
  const trackInteraction = useTrackSecurityAgentInteraction(scope);
  const repositories = useSecurityAgentRepositories(scope);

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

  if (
    !config.data &&
    (config.isError || (config.fetchStatus === 'paused' && committedConnectivity === 'offline'))
  ) {
    return (
      <PlatformErrorScreen
        title={t('securityAgent.settingsOverview.title')}
        variant="offline"
        message={t('securityAgent.settingsOverview.couldNotLoadSettings')}
        onRetry={() => void config.refetch()}
      />
    );
  }
  if (capability.status === 'error') {
    return (
      <PlatformErrorScreen
        title={t('securityAgent.settingsOverview.title')}
        message={t('securityAgent.settingsOverview.couldNotLoadPermissions')}
        onRetry={() => void capability.refetch()}
      />
    );
  }
  if (config.isLoading || !config.data || capability.status === 'loading') {
    return <SettingsOverviewSkeleton />;
  }

  const data = config.data;
  // Distinguish a settled-empty repo set from a still-loading or failed one:
  // a loading or failed query must not read as "zero repositories".
  const repositoriesEmpty = repositories.data?.length === 0;
  const repositoriesLoading = repositories.isLoading;
  const repositoriesError = repositories.isError;
  // An enable attempt with no effective repository would be refused by the
  // server, so the switch is disabled up front under the same rule: `selected`
  // mode with zero selected ids, or `all` mode with zero integration repos.
  const hasEffectiveRepo =
    data.repositorySelectionMode === 'all'
      ? (repositories.data?.length ?? 0) > 0
      : data.selectedRepositoryIds.length > 0;
  // A disabled agent with integration repos but no effective selection is the
  // first-enable deadlock: the switch is disabled (the server would refuse an
  // empty effective set) and the Repositories row only renders when enabled, so
  // offer a direct path to the repo picker. Hide the CTA only when the repo set
  // is settled and empty (nothing to select); a loading or failed repo query
  // keeps the CTA reachable.
  const showRepoCta =
    !data.isEnabled && capability.canManage && !hasEffectiveRepo && !repositoriesEmpty;
  let repoCountLabel = t('securityAgent.settingsOverview.repositoriesSelected', {
    count: data.selectedRepositoryIds.length,
  });
  if (data.repositorySelectionMode === 'all') {
    repoCountLabel = t('securityAgent.settingsOverview.allRepositories');
  } else if (data.selectedRepositoryIds.length === 1) {
    repoCountLabel = t('securityAgent.settingsOverview.repositorySelected', {
      count: data.selectedRepositoryIds.length,
    });
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

  const handleToggle = (value: boolean) => {
    void Haptics.selectionAsync();
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

  // Render the disabled-agent copy in three states: a still-loading repo set
  // (skeleton), a failed repo set (error + Retry), or a settled set (copy).
  const renderRepositoryStatus = () => {
    if (data.repositorySelectionMode === 'all' && repositoriesLoading) {
      return <Skeleton className="h-4 w-56 rounded" />;
    }
    if (data.repositorySelectionMode === 'all' && repositoriesError) {
      return (
        <View className="flex-row items-center gap-2">
          <Text variant="muted" className="text-xs">
            {t('securityAgent.settingsOverview.couldNotLoadRepositories')}
          </Text>
          <Text
            className="text-xs font-medium text-primary"
            onPress={() => void repositories.refetch()}
          >
            {t('common.retry')}
          </Text>
        </View>
      );
    }
    return (
      <Text variant="muted" className="text-xs">
        {getDisabledCopy(capability.canManage, hasEffectiveRepo)}
      </Text>
    );
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('securityAgent.settingsOverview.title')} headerRight={auditAction} />
      <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="gap-6 pt-4">
        <View className="flex-row items-center justify-between rounded-lg bg-secondary p-4">
          <View className="flex-1 pr-3">
            <Text className="text-sm font-medium">
              {t('securityAgent.settingsOverview.securityAgent')}
            </Text>
            <Text variant="muted" className="text-xs">
              {data.isEnabled ? repoCountLabel : t('securityAgent.settingsOverview.disabled')}
            </Text>
          </View>
          {capability.canManage ? (
            <Switch
              accessibilityLabel={t('securityAgent.settingsOverview.securityAgent')}
              value={data.isEnabled}
              disabled={setEnabled.isPending || (!data.isEnabled && !hasEffectiveRepo)}
              onValueChange={handleToggle}
            />
          ) : (
            <Text variant="muted" className="text-xs">
              {data.isEnabled
                ? t('securityAgent.settingsOverview.enabled')
                : t('securityAgent.settingsOverview.disabled')}
            </Text>
          )}
        </View>

        {!data.isEnabled && (
          <View className="gap-3">
            {renderRepositoryStatus()}
            {showRepoCta ? (
              <ConfigureRow
                icon={FolderGit2}
                title={t('securityAgent.settingsOverview.selectRepositories')}
                subtitle={t('securityAgent.settingsOverview.selectRepositoriesSubtitle')}
                onPress={() => {
                  router.push(getSecurityAgentPath(scope, 'settings/repositories'));
                }}
              />
            ) : null}
          </View>
        )}

        {data.isEnabled && (
          <View>
            <ConfigureRow
              icon={FolderGit2}
              title={t('securityAgent.settingsOverview.repositories')}
              subtitle={repoCountLabel}
              onPress={() => {
                router.push(getSecurityAgentPath(scope, 'settings/repositories'));
              }}
            />
            <ConfigureRow
              icon={Cpu}
              title={t('securityAgent.settingsOverview.modelsAndAnalysis')}
              subtitle={t('securityAgent.settingsOverview.analysisModeSubtitle', {
                mode: capitalize(data.analysisMode),
              })}
              onPress={() => {
                router.push(getSecurityAgentPath(scope, 'settings/analysis'));
              }}
            />
            <ConfigureRow
              icon={Zap}
              title={t('securityAgent.settingsOverview.automation')}
              subtitle={
                automationEnabledCount === 0
                  ? t('securityAgent.settingsOverview.automationAllOff')
                  : t('securityAgent.settingsOverview.automationCount', {
                      count: automationEnabledCount,
                    })
              }
              onPress={() => {
                router.push(getSecurityAgentPath(scope, 'settings/automation'));
              }}
            />
            <ConfigureRow
              icon={Bell}
              title={t('securityAgent.settingsOverview.notifications')}
              subtitle={
                notificationsEnabledCount === 0
                  ? t('securityAgent.settingsOverview.off')
                  : t('securityAgent.settingsOverview.notificationsCount', {
                      count: notificationsEnabledCount,
                    })
              }
              onPress={() => {
                router.push(getSecurityAgentPath(scope, 'settings/notifications'));
              }}
            />
            <ConfigureRow
              icon={Clock}
              title={t('securityAgent.settingsOverview.slaPolicy')}
              subtitle={
                data.slaEnabled
                  ? t('securityAgent.settingsOverview.on')
                  : t('securityAgent.settingsOverview.off')
              }
              last
              onPress={() => {
                router.push(getSecurityAgentPath(scope, 'settings/sla'));
              }}
            />
          </View>
        )}
      </TabScreenScrollView>
    </View>
  );
}
