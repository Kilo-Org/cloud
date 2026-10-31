/* eslint-disable max-lines -- the dashboard composes the sync controls, dismiss-failure cards, reconcile cards, metrics, and sections; each is a small rendered surface that mirrors the shared retry-card pattern. Splitting would re-encode the same hooks. */
import {
  buildSecurityDashboardMetrics,
  type DashboardMetricTone,
  type DashboardStats,
  getAnalysisIncompleteCount,
  getSecurityRepositoriesInScope,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useFocusEffect } from 'expo-router';
import { RefreshCw, Settings, ShieldAlert } from '@/components/ui/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { RefreshControl } from '@/components/ui/refresh-control';
import { toast } from 'sonner-native';

import { QueryError } from '@/components/query-error';
import { AuditReportButton } from '@/components/security-agent/audit-report-button';
import { Button } from '@/components/ui/button';
import { ScreenHeader } from '@/components/screen-header';
import { DashboardSections } from '@/components/security-agent/dashboard-sections';
import { SettingsRecoveryStatus } from '@/components/security-agent/settings-recovery-status';
import { SecurityCommandRetryCard } from '@/components/security-agent/security-command-retry-card';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { SpinningIcon } from '@/components/ui/spinning-icon';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { i18n } from '@/i18n';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { formatNumber, formatPercent } from '@/lib/format';
import {
  useRetrySecurityAgentSettings,
  useSecurityAgentCapability,
  useSecurityAgentConfig,
  useSecurityAgentDashboardStats,
  useSecurityAgentLastSyncTime,
  useSecurityAgentRepositories,
  useTriggerSecuritySync,
} from '@/lib/hooks/use-security-agent';
import {
  isSecuritySyncInProgress,
  isSecuritySyncRetryable,
  securitySyncReconcileCopy,
} from '@/lib/security-agent-ledger';
import { useSecurityAgentSyncRunning } from '@/lib/hooks/use-security-agent-sync-running';
import {
  securityDismissFailureCopy,
  useSecurityDismissFailures,
} from '@/lib/hooks/use-security-dismiss-draft';
import { useMutationOutbox } from '@/lib/persist/use-mutation-outbox';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useRelativeTimeNow } from '@/lib/hooks/use-now-ticker';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { useThemedActionSheetOptions } from '@/lib/hooks/use-themed-action-sheet';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

// The input one sync attempt carries: the repository filter it was started
// under, and the operation key a reconcile row replays.
type SyncIntent = { repoFullName?: string; operationKey?: string };

// A submit whose sync the screen is still waiting to see: `at` is when it
// reported, and `duplicate` marks the ledger refusing it because the same submit
// was already in flight (whose command may not exist yet).
type SyncWatch = { at: number; duplicate: boolean };

// How long a refused duplicate keeps the controls in progress. The submit it
// refused settles, or loses its ledger lease, well inside this window; a screen
// that never sees that submit must still give the controls back.
const DUPLICATE_SYNC_WATCH_MS = 30_000;

const METRIC_TONE_CLASS = {
  danger: 'text-destructive',
  warning: 'text-warn',
  neutral: 'text-muted-foreground',
} satisfies Record<DashboardMetricTone, string>;

export function buildLocalizedMetrics(data: DashboardStats, slaEnabled: boolean) {
  const metrics = buildSecurityDashboardMetrics(data, slaEnabled);
  const number = (value: number) => formatNumber(value, i18n.language);
  // The tile value counts every severity, so the detail line names every
  // severity: medium and low share one bucket, which disappears while empty.
  // Mirrors severityBreakdownDetail in @kilocode/app-shared.
  const breakdownDetail = (counts: DashboardStats['severity']) => {
    const parts = { critical: number(counts.critical), high: number(counts.high) };
    const mediumLow = counts.medium + counts.low;
    return mediumLow > 0
      ? i18n.t('securityAgent.dashboardMetrics.deadlinePassedDetailWithMediumLow', {
          ...parts,
          mediumLow: number(mediumLow),
        })
      : i18n.t('securityAgent.dashboardMetrics.deadlinePassedDetail', parts);
  };

  return metrics.map(metric => {
    switch (metric.id) {
      case 'openFindings': {
        return Object.assign(metric, {
          label: i18n.t('securityAgent.dashboardMetrics.openFindings'),
          value: number(data.analysis.total),
          detail: breakdownDetail(data.severity),
        });
      }
      case 'exploitable': {
        return Object.assign(metric, {
          label: i18n.t('securityAgent.dashboard.confirmedExploitable'),
          value: number(data.analysis.exploitable),
          detail: i18n.t('securityAgent.dashboardMetrics.confirmedExploitableDetail'),
        });
      }
      case 'needsReview': {
        return Object.assign(metric, {
          label: i18n.t('securityAgent.dashboard.needsYourReview'),
          value: number(data.analysis.needsReview),
          detail: i18n.t('securityAgent.dashboardMetrics.needsReviewDetail'),
        });
      }
      case 'analysisIncomplete': {
        return Object.assign(metric, {
          label: i18n.t('securityAgent.dashboard.analysisNotComplete'),
          value: number(getAnalysisIncompleteCount(data.analysis)),
          detail: i18n.t('securityAgent.dashboardMetrics.analysisIncompleteDetail'),
        });
      }
      case 'slaCompliance': {
        const measured = data.sla.overall.total > 0;
        const compliance = measured
          ? Math.round((data.sla.overall.withinSla / data.sla.overall.total) * 100)
          : null;
        return Object.assign(metric, {
          label: i18n.t('securityAgent.dashboardMetrics.slaCompliance'),
          value:
            compliance === null
              ? i18n.t('securityAgent.dashboard.notMeasured')
              : formatPercent(compliance, i18n.language),
          detail: measured
            ? i18n.t('securityAgent.dashboardMetrics.withinDeadlineDetail', {
                within: number(data.sla.overall.withinSla),
                total: number(data.sla.overall.total),
              })
            : i18n.t('securityAgent.dashboardMetrics.noDeadlineData'),
        });
      }
      case 'deadlinePassed': {
        const overdue = data.sla.bySeverity;
        return Object.assign(metric, {
          label: i18n.t('securityAgent.dashboardMetrics.deadlinePassed'),
          value: number(data.sla.overall.overdue),
          detail: breakdownDetail({
            critical: overdue.critical.overdue,
            high: overdue.high.overdue,
            medium: overdue.medium.overdue,
            low: overdue.low.overdue,
          }),
        });
      }
      case 'dueSoon': {
        return Object.assign(metric, {
          label: i18n.t('securityAgent.dashboardMetrics.dueThisWeek'),
          value: number(data.sla.dueSoon.total),
          detail: i18n.t('securityAgent.dashboardMetrics.dueThisWeekDetail', {
            exploitable: number(data.sla.dueSoon.exploitable),
          }),
        });
      }
      case 'noDeadline': {
        return Object.assign(metric, {
          label: i18n.t('securityAgent.dashboardMetrics.noDeadline'),
          value: number(data.sla.untrackedCount),
          detail:
            data.sla.untrackedCount > 0
              ? i18n.t('securityAgent.dashboardMetrics.reviewSlaAssignment')
              : i18n.t('securityAgent.dashboardMetrics.allOpenFindingsTracked'),
        });
      }
      default: {
        return metric;
      }
    }
  });
}

export function DashboardScreen({ scope }: Readonly<{ scope: string }>) {
  const pushOnce = useSinglePushRoute();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const themedSheet = useThemedActionSheetOptions();
  const { showActionSheetWithOptions } = useActionSheet();
  const [repoFullName, setRepoFullName] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);

  const config = useSecurityAgentConfig(scope);
  const dashboardStats = useSecurityAgentDashboardStats(scope, repoFullName);
  const lastSync = useSecurityAgentLastSyncTime(scope, repoFullName);
  const repositories = useSecurityAgentRepositories(scope);
  const capability = useSecurityAgentCapability(scope);
  const canManage = capability.canManage;
  // The entry renders this dashboard without waiting for the role read when the
  // config is already cached, so a failed read must say so here: otherwise a
  // manager sees the audit action silently missing and reads it as lost access.
  const capabilityRecovery = useRetrySecurityAgentSettings(scope);
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

  // A failed repositories fetch disables the filter controls until a refetch
  // succeeds; the same focus/foreground invalidation the findings list mounts
  // also retries it here, matching the org/personal key split below.
  useRouteForegroundRefresh(
    isPersonalSecurityScope(scope) ? [[['securityAgent']]] : [[['organizations', 'securityAgent']]]
  );

  const slaEnabled = config.data?.slaEnabled ?? true;
  const data = dashboardStats.data;
  const metrics = data ? buildLocalizedMetrics(data, slaEnabled) : [];

  const lastSyncTime = lastSync.data?.lastSyncTime;
  const now = useRelativeTimeNow();
  let lastSyncLabel = t('securityAgent.dashboard.notYetSynced');
  if (lastSync.isError) {
    lastSyncLabel = t('securityAgent.dashboard.syncStatusUnavailable');
  } else if (lastSyncTime) {
    lastSyncLabel = t('securityAgent.dashboard.lastSynced', {
      time: timeAgo(parseTimestamp(lastSyncTime), undefined, now),
    });
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
          // The repositories fetch failure disables the filter controls until
          // a refetch succeeds, so every dashboard refresh also retries it.
          repositories.refetch(),
        ]);
        setRefreshFailed(statsResult.isError || syncResult.isError);
      } finally {
        setRefreshing(false);
      }
    })();
  };

  // Repos aren't known yet (still loading or the fetch failed) — the filter
  // stays disabled instead of silently offering a shrunken "All repositories
  // only" option list. A failed fetch is recoverable: the retry card below and
  // pull-to-refresh both refetch the repositories query.
  const repoFilterUnavailable = repositories.isLoading || repositories.isError;

  // A non-retryable sync outcome ended the intent, so both sync controls
  // disable and the inline copy below explains the state.
  const syncBlocked = triggerSync.isError && !isSecuritySyncRetryable(triggerSync.error);
  // A sync outlives the request that started it. `syncWatch` marks a submit whose
  // command is still to be accounted for — accepted, or refused as already in
  // flight — and `syncRunning` is the server's own view of the run, so both sync
  // controls stay in a progress state for the whole sync instead of only for the
  // submission, and the refresh effect below fires when it ends.
  const [syncWatch, setSyncWatch] = useState<SyncWatch | null>(null);
  // Whether the run a watch points at was ever visible in the server's list:
  // once it is, its disappearance ends the watch instead of the window.
  const sawSyncRun = useRef(false);
  const syncRunning = useSecurityAgentSyncRunning(scope, syncWatch !== null);
  const syncInFlight = triggerSync.isPending || syncWatch !== null || syncRunning.syncRunning;
  const syncDisabled = syncInFlight || syncBlocked;
  // React Query clears a mutation's error when the next attempt starts, so the
  // failure copy and the retry under it blink out for the length of the retry —
  // the screen looked like the tap did nothing. Hold the failure being retried,
  // together with the intent that produced it, until that attempt reports its
  // own outcome: a retry must resubmit the failed intent, not whatever filter
  // the reader switched to meanwhile.
  const [lastSyncAttempt, setLastSyncAttempt] = useState<{
    error: Error | null;
    intent: SyncIntent;
  } | null>(null);
  const syncFailure = triggerSync.error ?? lastSyncAttempt?.error ?? null;
  const syncRetryable = syncFailure !== null && isSecuritySyncRetryable(syncFailure);
  // The ledger's in-progress conflict is not a failure of this sync: it is the
  // sync already running under the same operation key. It gets the running
  // presentation instead of a sentence with a Retry that would collide again.
  const syncFailureInProgress = syncFailure !== null && isSecuritySyncInProgress(syncFailure);

  // The run's own read ends an accepted submit's watch: a read taken after the
  // accept that reports no active sync command means the server has finished the
  // run, so the control returns to its normal state. A refused duplicate ends the
  // same way once the run it pointed at became visible; until then it waits for
  // the window below, because that run's command may not exist yet.
  useEffect(() => {
    if (syncWatch === null || triggerSync.isPending) {
      return;
    }
    if (syncRunning.syncRunning) {
      sawSyncRun.current = true;
      return;
    }
    if (syncRunning.updatedAt <= syncWatch.at) {
      return;
    }
    if (syncWatch.duplicate && !sawSyncRun.current) {
      return;
    }
    setSyncWatch(null);
  }, [syncWatch, triggerSync.isPending, syncRunning.syncRunning, syncRunning.updatedAt]);

  // A refused duplicate names a submit that is admitted server-side, so the
  // screen reports progress instead of a failure. That submit can only settle or
  // lose its lease inside the ledger's window, but the screen must not spin on a
  // submit it never sees: the watch expires on its own.
  useEffect(() => {
    if (syncWatch === null || !syncWatch.duplicate) {
      return () => undefined;
    }
    const remaining = syncWatch.at + DUPLICATE_SYNC_WATCH_MS - Date.now();
    if (remaining <= 0) {
      setSyncWatch(null);
      return () => undefined;
    }
    const expiry = setTimeout(() => {
      setSyncWatch(null);
    }, remaining);
    return () => {
      clearTimeout(expiry);
    };
  }, [syncWatch]);

  // A finished sync changes what the dashboard shows — "Last synced" and the
  // repository sync state — so refresh both without making the reader leave and
  // come back. The command observer invalidates the same queries for a tracked
  // command; this covers a run whose command this screen never tracked.
  const wasSyncInFlight = useRef(false);
  const refetchDashboardStats = dashboardStats.refetch;
  const refetchLastSync = lastSync.refetch;
  useEffect(() => {
    if (syncInFlight) {
      wasSyncInFlight.current = true;
      return;
    }
    if (!wasSyncInFlight.current) {
      return;
    }
    wasSyncInFlight.current = false;
    void refetchDashboardStats();
    void refetchLastSync();
  }, [syncInFlight, refetchDashboardStats, refetchLastSync]);

  // One submit path for every control that starts a sync — the header button,
  // the empty-state action, the retry beside the failure copy, and a
  // reconcile-row retry — so their handlers cannot drift apart.
  const startSync = (intent: SyncIntent) => {
    setLastSyncAttempt({ error: triggerSync.error, intent });
    sawSyncRun.current = false;
    setSyncWatch(null);
    triggerSync.mutate(intent, {
      onSuccess: () => {
        setLastSyncAttempt(null);
        // The 202 accepts the command; the worker runs it afterwards, so the
        // progress state follows the run instead of stopping at the response.
        setSyncWatch({ at: Date.now(), duplicate: false });
        toast.success(t('securityAgent.dashboard.syncQueued'));
      },
      onError: error => {
        // A same-key conflict means another submit is in flight right now, so
        // this screen is looking at a sync that is already running.
        if (isSecuritySyncInProgress(error)) {
          setSyncWatch({ at: Date.now(), duplicate: true });
        }
      },
      onSettled: () => {
        refreshOutbox();
      },
    });
  };

  const openRepoFilter = () => {
    if (repoFilterUnavailable) {
      return;
    }
    const repoNames = getSecurityRepositoriesInScope(repositories.data ?? [], config.data).map(
      repo => repo.fullName
    );
    const options = [t('common.allRepositories'), ...repoNames, t('common.cancel')];
    showActionSheetWithOptions(
      { ...themedSheet, options, cancelButtonIndex: options.length - 1 },
      index => {
        if (index === undefined || index === options.length - 1) {
          return;
        }
        setRepoFullName(index === 0 ? undefined : repoNames[index - 1]);
      }
    );
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        className="px-6"
        title={t('common.securityAgent')}
        // Size-11 (44dp) icon buttons: findings and settings, plus the audit
        // overflow when the viewer can manage the agent. Declaring exactly the
        // buttons this viewer renders drops the actions onto their own row
        // before the one-line CJK title loses its readable minimum.
        headerRightWidth={canManage ? 3 * 44 : 2 * 44}
        headerRight={
          <View className="flex-row items-center gap-2">
            <IconButton
              onPress={() => {
                pushOnce(getSecurityAgentPath(scope, 'findings'));
              }}
              accessibilityLabel={t('common.findings')}
            >
              <ShieldAlert size={20} color={colors.foreground} />
            </IconButton>
            <IconButton
              onPress={() => {
                pushOnce(getSecurityAgentPath(scope, 'settings'));
              }}
              accessibilityLabel={t('securityAgent.dashboard.settings')}
            >
              <Settings size={20} color={colors.foreground} />
            </IconButton>
            {canManage ? <AuditReportButton scope={scope} /> : null}
          </View>
        }
      />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-6 gap-4"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >
        {capability.status === 'error' ? (
          <SettingsRecoveryStatus
            message={t('securityAgent.settingsOverview.couldNotLoadPermissions')}
            isRetrying={capabilityRecovery.isRetrying}
            onRetry={() => void capabilityRecovery.retry()}
          />
        ) : null}
        <View className="flex-row items-center justify-between gap-3">
          {/* The row's height comes from the 48 dp sync button beside the
              filter, so the filter's own node carried only its two text lines
              (~32 dp) and a tap on the row's padding missed it. The shared row
              frame lifts the filter to the whole row; `justify-center` keeps
              the lines where they already sat. */}
          <Pressable
            onPress={openRepoFilter}
            disabled={repoFilterUnavailable}
            className={cn(
              ROW_TARGET_CLASS,
              'flex-1 justify-center active:opacity-70',
              repoFilterUnavailable && 'opacity-50'
            )}
            accessibilityRole="button"
            accessibilityLabel={t('securityAgent.dashboard.filterByRepository')}
            accessibilityState={{ disabled: repoFilterUnavailable }}
          >
            <Text className="text-sm font-medium" numberOfLines={1}>
              {repoFullName ?? t('common.allRepositories')}
            </Text>
            <Text variant="muted" className="text-xs">
              {syncInFlight ? t('securityAgent.dashboard.syncing') : lastSyncLabel}
            </Text>
          </Pressable>
          <IconButton
            onPress={() => {
              startSync({ repoFullName });
            }}
            disabled={syncDisabled}
            accessibilityLabel={t('securityAgent.dashboard.syncNow')}
            accessibilityState={{ disabled: syncDisabled, busy: syncInFlight }}
            className={cn(syncBlocked && 'opacity-50')}
          >
            <SpinningIcon
              icon={RefreshCw}
              size={18}
              color={colors.mutedForeground}
              spinning={syncInFlight}
            />
          </IconButton>
        </View>

        {repositories.isError ? (
          <SecurityCommandRetryCard
            lastError={t('common.couldNotLoadRepositories')}
            retryable
            onRetry={() => {
              void repositories.refetch();
            }}
          />
        ) : null}

        {refreshFailed ? (
          <Text className="text-xs text-warn">{t('securityAgent.dashboard.refreshFailed')}</Text>
        ) : null}

        {syncFailure !== null && !syncFailureInProgress ? (
          <View className="flex-row items-center gap-3">
            {/* While a retry runs this sentence is the failure being retried,
                not a fresh one, so it steps back from error red — to the warn
                tone this screen already gives its other degraded state — while
                the control reports the attempt. */}
            <Text
              className={cn(
                'flex-1 text-xs',
                triggerSync.isPending ? 'text-warn' : 'text-destructive'
              )}
            >
              {syncFailure.message}
            </Text>
            {syncRetryable ? (
              // The retry sits beside the sentence it retries and reports its
              // own progress: a failed sync can settle in a blink, so the
              // header icon's flash alone read as "nothing happened".
              <Button
                size="sm"
                variant="ghost"
                loading={triggerSync.isPending}
                // A busy non-primary control dims itself, spinner included,
                // which left the control the reader just pressed fainter than
                // the header icon spinning beside it.
                className={cn(triggerSync.isPending && 'opacity-100')}
                onPress={() => {
                  startSync(lastSyncAttempt?.intent ?? { repoFullName });
                }}
              >
                <Text>{t('common.retry')}</Text>
              </Button>
            ) : null}
          </View>
        ) : null}

        {dismissFailures.failures.map(failure => (
          <SecurityCommandRetryCard
            key={failure.findingId}
            lastError={securityDismissFailureCopy(failure)}
            retryable={failure.retryable === true}
            onRetry={() => {
              pushOnce(getSecurityAgentPath(scope, `dismiss/${failure.findingId}`));
            }}
            onDiscard={() => {
              dismissFailures.clear(failure.findingId);
            }}
          />
        ))}

        {/* A reconcile row says the previous attempt may not have completed and
            offers a same-key retry. While a sync is in flight the screen already
            knows its outcome is undecided: the run is visible above, and a second
            retry from this row would collide with it. The row is not lost — a
            failed run brings it straight back. */}
        {(syncInFlight ? [] : reconcileRows).map(row => (
          <SecurityCommandRetryCard
            key={row.fingerprint}
            lastError={securitySyncReconcileCopy()}
            retryable
            onRetry={() => {
              const input = row.input as { repoFullName?: string };
              startSync({ repoFullName: input.repoFullName, operationKey: row.operationKey });
            }}
            onDiscard={() => {
              void removeOutboxRow(row.fingerprint);
            }}
          />
        ))}

        {/* `isPending` rather than `isLoading`: a NetInfo-paused read is pending
            without fetching, and it must show this skeleton instead of an empty
            metrics row. */}
        {dashboardStats.isPending ? (
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
            {/* Both actions take the shared row frame: `min-h-11` measured
                38.5 dp here (NativeWind's rem is 14 pt), under the touch
                floor, and the row only grows to the frame the header's icon
                buttons already use. */}
            <Pressable
              onPress={() => {
                startSync({ repoFullName });
              }}
              disabled={syncDisabled}
              accessibilityRole="button"
              accessibilityLabel={t('securityAgent.dashboard.syncFindings')}
              accessibilityState={{
                disabled: syncDisabled,
                busy: syncInFlight,
              }}
              className={cn(
                ROW_TARGET_CLASS,
                'flex-row items-center gap-1.5 active:opacity-70',
                syncBlocked && 'opacity-50'
              )}
            >
              {syncInFlight && (
                <SpinningIcon icon={RefreshCw} size={12} color={colors.mutedForeground} spinning />
              )}
              <Text className="text-xs font-medium text-primary">
                {t('securityAgent.dashboard.syncFindings')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                pushOnce(getSecurityAgentPath(scope, 'settings/repositories'));
              }}
              accessibilityRole="button"
              accessibilityLabel={t('securityAgent.dashboard.manageRepositories')}
              className={cn(ROW_TARGET_CLASS, 'justify-center active:opacity-70')}
            >
              <Text className="text-xs font-medium text-primary">
                {t('securityAgent.dashboard.manageRepositories')}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {dashboardStats.isError && !data ? (
          <QueryError
            variant="server"
            placement="top"
            title={t('securityAgent.dashboard.couldNotLoad')}
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
