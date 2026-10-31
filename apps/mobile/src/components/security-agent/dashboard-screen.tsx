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
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { RefreshControl } from '@/components/ui/refresh-control';
import { toast } from 'sonner-native';

import { QueryError } from '@/components/query-error';
import { AuditReportButton } from '@/components/security-agent/audit-report-button';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { DashboardSections } from '@/components/security-agent/dashboard-sections';
import { SettingsRecoveryStatus } from '@/components/security-agent/settings-recovery-status';
import { SecurityCommandRetryCard } from '@/components/security-agent/security-command-retry-card';
import { severityCountPhrase } from '@/components/security-agent/severity-count-phrase';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { SpinningIcon } from '@/components/ui/spinning-icon';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { i18n } from '@/i18n';
import { INLINE_LINK_BOX_CLASS, ROW_TARGET_CLASS, STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { formatNumber, formatPercent, UNMEASURED_VALUE } from '@/lib/format';
import {
  useRetrySecurityAgentSettings,
  useSecurityAgentCapability,
  useSecurityAgentConfig,
  useSecurityAgentDashboardStats,
  useSecurityAgentLastSyncTime,
  useSecurityAgentRepositories,
  useTriggerSecuritySync,
} from '@/lib/hooks/use-security-agent';
import { isSecuritySyncRetryable, securitySyncReconcileCopy } from '@/lib/security-agent-ledger';
import { useSecurityScopeTitle } from '@/lib/hooks/use-security-scope-title';
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

const METRIC_TONE_CLASS = {
  danger: 'text-destructive',
  warning: 'text-warn',
  neutral: 'text-muted-foreground',
} satisfies Record<DashboardMetricTone, string>;

export function buildLocalizedMetrics(
  data: DashboardStats,
  slaEnabled: boolean,
  neverSynced = false
) {
  const metrics = buildSecurityDashboardMetrics(data, slaEnabled);
  const number = (value: number) => formatNumber(value, i18n.language);
  // The tile value counts every severity, so the detail line names every
  // severity: medium and low share one bucket, which disappears while empty.
  // Mirrors severityBreakdownDetail in @kilocode/app-shared. Each bucket is a
  // counted phrase of its own, because one `count` cannot agree three numbers.
  const breakdownDetail = (counts: DashboardStats['severity']) => {
    const critical = severityCountPhrase('breakdownCritical', counts.critical);
    const high = severityCountPhrase('breakdownHigh', counts.high);
    const mediumLow = counts.medium + counts.low;
    return mediumLow > 0
      ? i18n.t('securityAgent.dashboardMetrics.deadlinePassedDetailWithMediumLow', {
          critical,
          high,
          mediumLow: severityCountPhrase('breakdownMediumLow', mediumLow),
        })
      : i18n.t('securityAgent.dashboardMetrics.deadlinePassedDetail', { critical, high });
  };

  const localized = metrics.map(metric => {
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
          // An unmeasured value is a dash in the numeric slot, not a word: the
          // tile's value style is the large mono count, so "Not measured" read
          // as a heavy placeholder that outweighed the real counts beside it,
          // and the detail line below already explains why there is none.
          value: compliance === null ? UNMEASURED_VALUE : formatPercent(compliance, i18n.language),
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

  // Before the first sync nothing has been measured, so every tile read a zero
  // count and, under it, a line that described the zeros as a clean report
  // ("All open findings tracked", "No findings have an SLA deadline yet").
  // A dash in the numeric slot and the screen's own not-yet-synced line state
  // the measurement is simply absent.
  if (!neverSynced) {
    return localized;
  }
  return localized.map(metric =>
    Object.assign(metric, {
      value: UNMEASURED_VALUE,
      detail: i18n.t('securityAgent.dashboard.notYetSynced'),
      tone: 'neutral' as const,
    })
  );
}

export function DashboardScreen({ scope }: Readonly<{ scope: string }>) {
  const pushOnce = useSinglePushRoute();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const scopeTitle = useSecurityScopeTitle(scope);
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
  // The stored absence of a sync, the same read that paints "Not yet synced"
  // under the filter: nothing has been measured yet, so the tiles and the
  // priority row must not read their empty result as a clean report. A read
  // that is still loading or failed is not this state.
  const neverSynced = lastSync.data?.lastSyncTime === null;
  const data = dashboardStats.data;
  const metrics = data ? buildLocalizedMetrics(data, slaEnabled, neverSynced) : [];

  const lastSyncTime = lastSync.data?.lastSyncTime;
  // The prompt stands in for an empty grid, never for counts: a scope whose
  // owner-level sync stamp is missing can still hold findings from a partial
  // run, and those must stay visible. A read that has not answered yet keeps
  // its own surface (the skeleton or the retry card).
  const showFirstSyncPrompt = neverSynced && data?.analysis.total === 0;
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
  const syncDisabled = triggerSync.isPending || syncBlocked;
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

  // One submit path for every control that starts a sync — the header button,
  // the empty-state action, the retry beside the failure copy, and a
  // reconcile-row retry — so their handlers cannot drift apart.
  const startSync = (intent: SyncIntent) => {
    setLastSyncAttempt({ error: triggerSync.error, intent });
    triggerSync.mutate(intent, {
      onSuccess: () => {
        setLastSyncAttempt(null);
        toast.success(t('securityAgent.dashboard.syncQueued'));
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
        title={scopeTitle}
        eyebrow={t('common.securityAgent')}
        // The scope name is the one thing that tells two organizations apart,
        // so it wraps to a second line rather than ellipsizing its tail.
        titleNumberOfLines={2}
        // The trailing cluster's laid-out width — 48 dp icon boxes 7 dp apart:
        // findings and settings, plus the audit overflow when the viewer can
        // manage the agent. Declaring 44 dp boxes understated the cluster, so
        // the stacking decision believed the heading kept 48 dp more than it
        // has. The widths the controls actually render are what it reserves.
        headerRightWidth={canManage ? 3 * 48 + 2 * 7 : 2 * 48 + 7}
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
            {/* A scope with no measured sync states that fact once per
                surface that reports it: the first-sync prompt carries it, and
                a scope that already holds findings shows it as each tile's
                caption and in the "Act first" row. The filter row above them
                would be the same sentence a third time, so it keeps its
                status line only once a sync has been measured. */}
            {neverSynced ? null : (
              <Text variant="muted" className="text-xs">
                {lastSyncLabel}
              </Text>
            )}
          </Pressable>
          <IconButton
            onPress={() => {
              startSync({ repoFullName });
            }}
            disabled={syncDisabled}
            accessibilityLabel={t('securityAgent.dashboard.syncNow')}
            accessibilityState={{ disabled: syncDisabled, busy: triggerSync.isPending }}
            className={cn(syncBlocked && 'opacity-50')}
          >
            <SpinningIcon
              icon={RefreshCw}
              size={18}
              color={colors.mutedForeground}
              spinning={triggerSync.isPending}
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

        {syncFailure ? (
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

        {reconcileRows.map(row => (
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

        {dashboardStats.isError && !data ? (
          <QueryError
            variant="server"
            placement="top"
            title={t('securityAgent.dashboard.couldNotLoad')}
            onRetry={() => void dashboardStats.refetch()}
            isRetrying={dashboardStats.isFetching}
          />
        ) : null}

        {slaEnabled && data && data.sla.overall.total === 0 ? (
          <View className="flex-row items-center gap-4">
            {/* The refresh control in the filter row above is this screen's one
                sync affordance; a second "Sync findings" link here repeated it
                inside the empty state that points at the repositories instead.
                The link takes the layout-neutral inline box: a 48 dp frame
                around this `text-xs` line centred the text with 17 dp of its
                own space above and below, so the link floated roughly twice as
                far from its neighbours as the sections sit from each other. The
                28 dp box is the audit's own minimum, the `-my-[7px]` cancels
                the box's overflow so the line sits one section gap away, and
                `hitSlop` carries the 44 dp touch region. */}
            <Pressable
              onPress={() => {
                pushOnce(getSecurityAgentPath(scope, 'settings/repositories'));
              }}
              hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel={t('securityAgent.dashboard.manageRepositories')}
              className={cn(INLINE_LINK_BOX_CLASS, 'active:opacity-70')}
            >
              <Text className="text-xs font-medium text-primary">
                {t('securityAgent.dashboard.manageRepositories')}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {showFirstSyncPrompt ? (
          // Every count reads 0 before the first sync finishes, so the KPI grid
          // and the posture sections looked like a clean result. Until a sync
          // has completed the screen offers the sync itself instead.
          <EmptyState
            icon={ShieldAlert}
            placement="top"
            className="py-6"
            title={t('securityAgent.dashboard.notYetSynced')}
            action={
              <Button
                className={STATE_ACTION_CLASS}
                disabled={syncDisabled}
                loading={triggerSync.isPending}
                accessibilityLabel={t('securityAgent.dashboard.syncFindings')}
                onPress={() => {
                  startSync({ repoFullName });
                }}
              >
                <Text>{t('securityAgent.dashboard.syncFindings')}</Text>
              </Button>
            }
          />
        ) : (
          <>
            {/* `isPending` rather than `isLoading`: a NetInfo-paused read is
                pending without fetching, and it must show this skeleton instead
                of an empty metrics row. */}
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
                      className={cn(
                        'font-mono text-xl font-semibold',
                        METRIC_TONE_CLASS[metric.tone]
                      )}
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

            {data ? (
              <DashboardSections
                scope={scope}
                data={data}
                slaEnabled={slaEnabled}
                repoFullName={repoFullName}
                neverSynced={neverSynced}
              />
            ) : null}
          </>
        )}
      </TabScreenScrollView>
    </View>
  );
}
