import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Bell, Clock, Cpu, FolderGit2, Zap } from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { Switch, View } from 'react-native';

import { AuditReportButton } from '@/components/security-agent/audit-report-button';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import {
  useSecurityAgentCapability,
  useSecurityAgentConfig,
  useSetSecurityAgentEnabled,
  useTrackSecurityAgentInteraction,
} from '@/lib/hooks/use-security-agent';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { capitalize } from '@/lib/utils';

function SettingsOverviewSkeleton() {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Settings" />
      <View className="gap-3 px-6 pt-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
      </View>
    </View>
  );
}

type SettingsOverviewPresentation = 'inline' | 'route';

export function SettingsOverviewScreen({
  scope,
  presentation = 'inline',
}: Readonly<{ scope: string; presentation?: SettingsOverviewPresentation }>) {
  const router = useRouter();
  const config = useSecurityAgentConfig(scope);
  const canManage = useSecurityAgentCapability(scope).canManage;
  const setEnabled = useSetSecurityAgentEnabled(scope);
  const trackInteraction = useTrackSecurityAgentInteraction(scope);

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

  if (config.isError && !config.data) {
    return (
      <PlatformErrorScreen
        title="Settings"
        variant="offline"
        message="Could not load Security Agent settings"
        onRetry={() => void config.refetch()}
      />
    );
  }
  if (config.isLoading || !config.data) {
    return <SettingsOverviewSkeleton />;
  }

  const data = config.data;
  const repoCountLabel =
    data.repositorySelectionMode === 'all'
      ? 'All repositories'
      : `${data.selectedRepositoryIds.length} ${data.selectedRepositoryIds.length === 1 ? 'repository' : 'repositories'} selected`;
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
  const auditAction = canManage ? <AuditReportButton scope={scope} /> : null;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Settings" headerRight={auditAction} />
      <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="gap-6 pt-4">
        <View className="flex-row items-center justify-between rounded-lg bg-secondary p-4">
          <View className="flex-1 pr-3">
            <Text className="text-sm font-medium">Security Agent</Text>
            <Text variant="muted" className="text-xs">
              {data.isEnabled ? repoCountLabel : 'Disabled'}
            </Text>
          </View>
          {canManage ? (
            <Switch
              accessibilityLabel="Security Agent"
              value={data.isEnabled}
              disabled={setEnabled.isPending}
              onValueChange={handleToggle}
            />
          ) : (
            <Text variant="muted" className="text-xs">
              {data.isEnabled ? 'Enabled' : 'Disabled'}
            </Text>
          )}
        </View>

        {!data.isEnabled && (
          <Text variant="muted" className="text-xs">
            {canManage
              ? 'Turn on Security Agent to sync Dependabot alerts, choose repositories, and configure automation.'
              : 'Security Agent is disabled. Only organization owners and billing managers can turn it on.'}
          </Text>
        )}

        {data.isEnabled && (
          <View>
            <ConfigureRow
              icon={FolderGit2}
              title="Repositories"
              subtitle={repoCountLabel}
              onPress={() => {
                router.push(getSecurityAgentPath(scope, 'settings/repositories'));
              }}
            />
            <ConfigureRow
              icon={Cpu}
              title="Models & analysis"
              subtitle={`${capitalize(data.analysisMode)} analysis`}
              onPress={() => {
                router.push(getSecurityAgentPath(scope, 'settings/analysis'));
              }}
            />
            <ConfigureRow
              icon={Zap}
              title="Automation"
              subtitle={
                automationEnabledCount === 0 ? 'All off' : `${automationEnabledCount} of 3 enabled`
              }
              onPress={() => {
                router.push(getSecurityAgentPath(scope, 'settings/automation'));
              }}
            />
            <ConfigureRow
              icon={Bell}
              title="Notifications"
              subtitle={
                notificationsEnabledCount === 0
                  ? 'Off'
                  : `${notificationsEnabledCount} of 2 enabled`
              }
              onPress={() => {
                router.push(getSecurityAgentPath(scope, 'settings/notifications'));
              }}
            />
            <ConfigureRow
              icon={Clock}
              title="SLA policy"
              subtitle={data.slaEnabled ? 'On' : 'Off'}
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
