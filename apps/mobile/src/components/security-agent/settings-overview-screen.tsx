import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Bell, Clock, Cpu, FolderGit2, Zap } from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { ScrollView, Switch, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { QueryError } from '@/components/query-error';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useSecurityAgentConfig,
  useSecurityAgentEditCapability,
  useSetSecurityAgentEnabled,
  useTrackSecurityAgentInteraction,
} from '@/lib/hooks/use-security-agent';
import { getSecurityAgentPath } from '@/lib/security-agent';

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

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function SettingsOverviewScreen({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const config = useSecurityAgentConfig(scope);
  const canManage = useSecurityAgentEditCapability(scope);
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
      <View className="flex-1 bg-background">
        <ScreenHeader title="Settings" />
        <QueryError
          className="flex-1"
          message="Could not load Security Agent settings"
          onRetry={() => void config.refetch()}
        />
      </View>
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
    setEnabled.mutate({
      isEnabled: value,
      repositorySelectionMode: data.repositorySelectionMode,
      selectedRepositoryIds: data.selectedRepositoryIds,
    });
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Settings" />
      <ScrollView className="flex-1 px-6" contentContainerClassName="gap-6 pt-4 pb-24">
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
      </ScrollView>
    </View>
  );
}
