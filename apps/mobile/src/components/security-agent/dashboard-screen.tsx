import {
  buildSecurityDashboardMetrics,
  type DashboardMetricTone,
  getSecurityAgentAuditUrl,
  getSecurityRepositoriesInScope,
} from '@kilocode/app-shared/security-agent';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { MoreHorizontal, RefreshCw, Settings, ShieldAlert } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { DashboardSections } from '@/components/security-agent/dashboard-sections';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { WEB_BASE_URL } from '@/lib/config';
import {
  useSecurityAgentConfig,
  useSecurityAgentDashboardStats,
  useSecurityAgentEditCapability,
  useSecurityAgentLastSyncTime,
  useSecurityAgentRepositories,
  useTriggerSecuritySync,
} from '@/lib/hooks/use-security-agent';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

const METRIC_TONE_CLASS: Record<DashboardMetricTone, string> = {
  danger: 'text-destructive',
  warning: 'text-warn',
  neutral: 'text-muted-foreground',
};

export function DashboardScreen({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const colors = useThemeColors();
  const { showActionSheetWithOptions } = useActionSheet();
  const [repoFullName, setRepoFullName] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);

  const config = useSecurityAgentConfig(scope);
  const dashboardStats = useSecurityAgentDashboardStats(scope, repoFullName);
  const lastSync = useSecurityAgentLastSyncTime(scope, repoFullName);
  const repositories = useSecurityAgentRepositories(scope);
  const canManage = useSecurityAgentEditCapability(scope);
  const triggerSync = useTriggerSecuritySync(scope);

  const slaEnabled = config.data?.slaEnabled ?? true;
  const data = dashboardStats.data;
  const metrics = data ? buildSecurityDashboardMetrics(data, slaEnabled) : [];

  const lastSyncTime = lastSync.data?.lastSyncTime;
  const lastSyncLabel = lastSyncTime
    ? `Last synced ${timeAgo(parseTimestamp(lastSyncTime))}`
    : 'Not yet synced';

  const handleRefresh = () => {
    void (async () => {
      setRefreshing(true);
      try {
        // Refresh only — never triggers a new sync.
        await Promise.all([dashboardStats.refetch(), lastSync.refetch()]);
      } finally {
        setRefreshing(false);
      }
    })();
  };

  const openRepoFilter = () => {
    const repoNames = getSecurityRepositoriesInScope(repositories.data ?? [], config.data).map(
      repo => repo.fullName
    );
    const options = ['All repositories', ...repoNames, 'Cancel'];
    showActionSheetWithOptions({ options, cancelButtonIndex: options.length - 1 }, index => {
      if (index === undefined || index === options.length - 1) {
        return;
      }
      setRepoFullName(index === 0 ? undefined : repoNames[index - 1]);
    });
  };

  const openMoreActions = () => {
    const options = ['View audit report', 'Cancel'];
    showActionSheetWithOptions({ options, cancelButtonIndex: 1 }, index => {
      if (index === 0) {
        void WebBrowser.openBrowserAsync(getSecurityAgentAuditUrl(WEB_BASE_URL, scope));
      }
    });
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Security Agent"
        headerRight={
          <View className="flex-row items-center">
            <Pressable
              onPress={() => {
                router.push(getSecurityAgentPath(scope, 'findings'));
              }}
              accessibilityRole="button"
              accessibilityLabel="Findings"
              className="size-11 items-center justify-center active:opacity-70"
            >
              <ShieldAlert size={20} color={colors.foreground} />
            </Pressable>
            <Pressable
              onPress={() => {
                router.push(getSecurityAgentPath(scope, 'settings'));
              }}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              className="size-11 items-center justify-center active:opacity-70"
            >
              <Settings size={20} color={colors.foreground} />
            </Pressable>
            {canManage ? (
              <Pressable
                onPress={openMoreActions}
                accessibilityRole="button"
                accessibilityLabel="More actions"
                className="size-11 items-center justify-center active:opacity-70"
              >
                <MoreHorizontal size={20} color={colors.foreground} />
              </Pressable>
            ) : null}
          </View>
        }
      />
      <ScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-4 pb-24"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >
        <View className="flex-row items-center justify-between gap-3">
          <Pressable
            onPress={openRepoFilter}
            className="flex-1 active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel="Filter by repository"
          >
            <Text className="text-sm font-medium" numberOfLines={1}>
              {repoFullName ?? 'All repositories'}
            </Text>
            <Text variant="muted" className="text-xs">
              {lastSyncLabel}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              triggerSync.mutate({ repoFullName });
            }}
            disabled={triggerSync.isPending}
            accessibilityRole="button"
            accessibilityLabel="Sync now"
            className="size-11 items-center justify-center active:opacity-70"
          >
            <RefreshCw size={18} color={colors.mutedForeground} />
          </Pressable>
        </View>

        {dashboardStats.isLoading ? (
          <View className="flex-row flex-wrap gap-3">
            <Skeleton className="h-24 w-[47%] rounded-lg" />
            <Skeleton className="h-24 w-[47%] rounded-lg" />
            <Skeleton className="h-24 w-[47%] rounded-lg" />
            <Skeleton className="h-24 w-[47%] rounded-lg" />
          </View>
        ) : (
          <View className="flex-row flex-wrap gap-3">
            {metrics.map(metric => (
              <View key={metric.label} className="w-[47%] gap-1 rounded-lg bg-secondary p-3">
                <Text variant="muted" className="text-xs">
                  {metric.label}
                </Text>
                <Text
                  className={cn('font-mono text-xl font-semibold', METRIC_TONE_CLASS[metric.tone])}
                >
                  {metric.value}
                </Text>
                <Text variant="muted" className="text-[11px]">
                  {metric.detail}
                </Text>
              </View>
            ))}
          </View>
        )}

        {dashboardStats.isError && !data ? (
          <Pressable
            className="rounded-lg bg-secondary p-3 active:opacity-70"
            onPress={() => {
              void dashboardStats.refetch();
            }}
          >
            <Text className="text-sm text-destructive">
              Could not load dashboard data. Tap to retry.
            </Text>
          </Pressable>
        ) : null}

        {data ? (
          <DashboardSections
            scope={scope}
            data={data}
            slaEnabled={slaEnabled}
            repoFullName={repoFullName}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}
