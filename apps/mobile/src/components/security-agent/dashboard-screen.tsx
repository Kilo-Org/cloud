/* eslint-disable max-lines -- the dashboard composes the sync controls, dismiss-failure cards, reconcile cards, metrics, and sections; each is a small rendered surface that mirrors the shared retry-card pattern. Splitting would re-encode the same hooks. */
import {
  buildSecurityDashboardMetrics,
  type DashboardMetricTone,
  getSecurityRepositoriesInScope,
} from '@kilocode/app-shared/security-agent';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useFocusEffect, useRouter } from 'expo-router';
import { RefreshCw, Settings, ShieldAlert } from '@/components/ui/icons';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import { toast } from 'sonner-native';

import { QueryError } from '@/components/query-error';
import { AuditReportButton } from '@/components/security-agent/audit-report-button';
import { ScreenHeader } from '@/components/screen-header';
import { DashboardSections } from '@/components/security-agent/dashboard-sections';
import { SecurityCommandRetryCard } from '@/components/security-agent/security-command-retry-card';
import { Skeleton } from '@/components/ui/skeleton';
import { SpinningIcon } from '@/components/ui/spinning-icon';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import {
  useSecurityAgentCapability,
  useSecurityAgentConfig,
  useSecurityAgentDashboardStats,
  useSecurityAgentLastSyncTime,
  useSecurityAgentRepositories,
  useTriggerSecuritySync,
} from '@/lib/hooks/use-security-agent';
import {
  isSecurityConfigurationError,
  isSecuritySyncRetryable,
  SECURITY_CONFIGURATION_COPY,
  SECURITY_SYNC_RECONCILE_COPY,
} from '@/lib/hooks/use-security-agent-mutations';
import { useSecurityDismissFailures } from '@/lib/hooks/use-security-dismiss-draft';
import { useMutationOutbox } from '@/lib/persist/use-mutation-outbox';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

const METRIC_TONE_CLASS = {
  danger: 'text-destructive',
  warning: 'text-warn',
  neutral: 'text-muted-foreground',
} satisfies Record<DashboardMetricTone, string>;

export function DashboardScreen({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const colors = useThemeColors();
  const { showActionSheetWithOptions } = useActionSheet();
  const [repoFullName, setRepoFullName] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);

  const config = useSecurityAgentConfig(scope);
  const dashboardStats = useSecurityAgentDashboardStats(scope, repoFullName);
  const lastSync = useSecurityAgentLastSyncTime(scope, repoFullName);
  const repositories = useSecurityAgentRepositories(scope);
  const canManage = useSecurityAgentCapability(scope).canManage;
  const triggerSync = useTriggerSecuritySync(scope);
  const dismissFailures = useSecurityDismissFailures(scope);
  const { refresh: refreshDismissFailures } = dismissFailures;
  // P1-E-40c: a crash mid-sync leaves a reconcile-first row; surface a card
  // (never auto-POST) and keep the list current after a retry or discard.
  const { needsReconcile, remove: removeOutboxRow, refresh: refreshOutbox } = useMutationOutbox();
  // Only the current dashboard scope's rows render and retry here: a row from
  // another scope must not show a card or POST this scope.
  const reconcileRows = needsReconcile.filter(row => row.scope === scope);

  // The dashboard stays mounted while the dismiss sheet is open, so re-read
  // the failed dismiss drafts on focus: a fresh failure must show a card and
  // an accepted dismissal must drop it.
  useFocusEffect(
    useCallback(() => {
      refreshDismissFailures();
      refreshOutbox();
    }, [refreshDismissFailures, refreshOutbox])
  );

  const slaEnabled = config.data?.slaEnabled ?? true;
  const data = dashboardStats.data;
  const metrics = data ? buildSecurityDashboardMetrics(data, slaEnabled) : [];

  const lastSyncTime = lastSync.data?.lastSyncTime;
  let lastSyncLabel = 'Not yet synced';
  if (lastSync.isError) {
    lastSyncLabel = 'Sync status unavailable';
  } else if (lastSyncTime) {
    lastSyncLabel = `Last synced ${timeAgo(parseTimestamp(lastSyncTime))}`;
  }

  const handleRefresh = () => {
    void (async () => {
      setRefreshing(true);
      setRefreshFailed(false);
      try {
        // Refresh only — never triggers a new sync. Stale data stays on
        // screen either way; a failed refresh just surfaces a brief warning.
        const [statsResult, syncResult] = await Promise.all([
          dashboardStats.refetch(),
          lastSync.refetch(),
        ]);
        setRefreshFailed(statsResult.isError || syncResult.isError);
      } finally {
        setRefreshing(false);
      }
    })();
  };

  // Repos aren't known yet (still loading or the fetch failed) — the filter
  // stays disabled instead of silently offering a shrunken "All repositories
  // only" option list.
  const repoFilterUnavailable = repositories.isLoading || repositories.isError;

  // A non-retryable sync outcome ended the intent, so both sync controls
  // disable and the inline copy below explains the state.
  const syncBlocked = triggerSync.isError && !isSecuritySyncRetryable(triggerSync.error);
  const syncDisabled = triggerSync.isPending || syncBlocked;

  const openRepoFilter = () => {
    if (repoFilterUnavailable) {
      return;
    }
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
            {canManage ? <AuditReportButton scope={scope} /> : null}
          </View>
        }
      />
      <TabScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-4"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >
        <View className="flex-row items-center justify-between gap-3">
          <Pressable
            onPress={openRepoFilter}
            disabled={repoFilterUnavailable}
            className={cn('flex-1 active:opacity-70', repoFilterUnavailable && 'opacity-50')}
            accessibilityRole="button"
            accessibilityLabel="Filter by repository"
            accessibilityState={{ disabled: repoFilterUnavailable }}
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
              triggerSync.mutate(
                { repoFullName },
                {
                  onSuccess: () => {
                    toast.success('Sync queued');
                  },
                  onSettled: () => {
                    refreshOutbox();
                  },
                }
              );
            }}
            disabled={syncDisabled}
            accessibilityRole="button"
            accessibilityLabel="Sync now"
            accessibilityState={{ disabled: syncDisabled, busy: triggerSync.isPending }}
            className={cn(
              'size-11 items-center justify-center active:opacity-70',
              syncBlocked && 'opacity-50'
            )}
          >
            <SpinningIcon
              icon={RefreshCw}
              size={18}
              color={colors.mutedForeground}
              spinning={triggerSync.isPending}
            />
          </Pressable>
        </View>

        {refreshFailed ? (
          <Text className="text-xs text-warn">Could not refresh — showing last synced data.</Text>
        ) : null}

        {triggerSync.isError ? (
          <Text className="text-xs text-destructive">
            {isSecurityConfigurationError(triggerSync.error)
              ? SECURITY_CONFIGURATION_COPY
              : triggerSync.error.message}
          </Text>
        ) : null}

        {dismissFailures.failures.map(failure => (
          <SecurityCommandRetryCard
            key={failure.findingId}
            lastError={failure.lastError}
            retryable={failure.retryable === true}
            onRetry={() => {
              router.push(getSecurityAgentPath(scope, `dismiss/${failure.findingId}`));
            }}
            onDiscard={() => {
              dismissFailures.clear(failure.findingId);
            }}
          />
        ))}

        {reconcileRows.map(row => (
          <SecurityCommandRetryCard
            key={row.fingerprint}
            lastError={SECURITY_SYNC_RECONCILE_COPY}
            retryable
            onRetry={() => {
              const input = row.input as { repoFullName?: string };
              triggerSync.mutate(
                { repoFullName: input.repoFullName, operationKey: row.operationKey },
                {
                  onSuccess: () => {
                    toast.success('Sync queued');
                  },
                  onSettled: () => {
                    refreshOutbox();
                  },
                }
              );
            }}
            onDiscard={() => {
              void removeOutboxRow(row.fingerprint);
            }}
          />
        ))}

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

        {slaEnabled && data && data.sla.overall.total === 0 ? (
          <View className="flex-row items-center gap-4">
            <Pressable
              onPress={() => {
                triggerSync.mutate(
                  { repoFullName },
                  {
                    onSuccess: () => {
                      toast.success('Sync queued');
                    },
                    onSettled: () => {
                      refreshOutbox();
                    },
                  }
                );
              }}
              disabled={syncDisabled}
              accessibilityRole="button"
              accessibilityLabel="Sync findings"
              accessibilityState={{
                disabled: syncDisabled,
                busy: triggerSync.isPending,
              }}
              className={cn(
                'min-h-11 flex-row items-center gap-1.5 active:opacity-70',
                syncBlocked && 'opacity-50'
              )}
            >
              {triggerSync.isPending && (
                <SpinningIcon icon={RefreshCw} size={12} color={colors.mutedForeground} spinning />
              )}
              <Text className="text-xs font-medium text-primary">Sync findings</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                router.push(getSecurityAgentPath(scope, 'settings/repositories'));
              }}
              accessibilityRole="button"
              accessibilityLabel="Manage repositories"
              className="min-h-11 justify-center active:opacity-70"
            >
              <Text className="text-xs font-medium text-primary">Manage repositories</Text>
            </Pressable>
          </View>
        ) : null}

        {dashboardStats.isError && !data ? (
          <QueryError
            variant="server"
            placement="top"
            title="Could not load dashboard data"
            onRetry={() => void dashboardStats.refetch()}
            isRetrying={dashboardStats.isFetching}
          />
        ) : null}

        {data ? (
          <DashboardSections
            scope={scope}
            data={data}
            slaEnabled={slaEnabled}
            repoFullName={repoFullName}
          />
        ) : null}
      </TabScreenScrollView>
    </View>
  );
}
