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
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { RefreshControl } from '@/components/ui/refresh-control';
import { toast } from 'sonner-native';

import { QueryError } from '@/components/query-error';
import { AuditReportButton } from '@/components/security-agent/audit-report-button';
import { Button } from '@/components/ui/button';
import { ScreenHeader } from '@/components/screen-header';
import {
  DashboardSections,
  DashboardSectionsSkeleton,
} from '@/components/security-agent/dashboard-sections';
import { SettingsRecoveryStatus } from '@/components/security-agent/settings-recovery-status';
import { SecurityCommandRetryCard } from '@/components/security-agent/security-command-retry-card';
import { severityCountPhrase } from '@/components/security-agent/severity-count-phrase';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { SpinningIcon } from '@/components/ui/spinning-icon';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { i18n } from '@/i18n';
import { INLINE_LINK_BOX_CLASS, ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
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
import {
  isSecuritySyncInProgress,
  isSecuritySyncRetryable,
  securitySyncPreconditionFor,
  securitySyncReconcileCopy,
} from '@/lib/security-agent-ledger';
import { useSecurityAgentSyncRunning } from '@/lib/hooks/use-security-agent-sync-running';
import { useManageRepositoryAccess } from '@/lib/hooks/use-manage-repository-access';
import { useSecurityScopeTitle } from '@/lib/hooks/use-security-scope-title';
import {
  securityDismissFailureCopy,
  useSecurityDismissFailures,
} from '@/lib/hooks/use-security-dismiss-draft';
import { useMutationOutbox } from '@/lib/persist/use-mutation-outbox';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useRelativeTimeNow } from '@/lib/hooks/use-now-ticker';
import { type SinglePushRoute, useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
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

// How long an accepted submit may keep them without a single readable status
// poll. The Worker lists the command before it answers the accept, so a readable
// server shows the run within one poll; past this window the screen stops
// claiming a sync it cannot see, while a run it does see keeps the state itself.
const ACCEPTED_SYNC_WATCH_MS = 60_000;

const METRIC_TONE_CLASS = {
  danger: 'text-destructive',
  warning: 'text-warn',
  neutral: 'text-muted-foreground',
} satisfies Record<DashboardMetricTone, string>;

/**
 * The metric tile's frame, shared with its placeholder so the loading state
 * cannot drift from the rendered card.
 */
const STAT_TILE_CLASS = 'w-[47%] gap-1 rounded-lg bg-secondary p-3';

// One placeholder per tile: the metrics fill four of them with or without SLA
// deadlines. Each bar is the loaded line's own box at the app's default text
// size — the `text-xs` label, the `text-xl` value and the `text-[11px]` detail
// — so the tile's height comes out the same and the loaded cards replace the
// placeholders without moving anything below them. The detail bar is the one
// line the loaded tile may not carry, so it is drawn only for the scope shape
// that carries it.
const STAT_TILE_PLACEHOLDERS = [0, 1, 2, 3] as const;
const STAT_LABEL_LINE_CLASS = 'h-4 rounded';
const STAT_VALUE_LINE_CLASS = 'h-7 rounded';
const STAT_DETAIL_LINE_CLASS = 'h-[15px] rounded';

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
  // The filter row above already states that nothing has synced, so a dash in
  // the numeric slot carries the measurement's absence and the tile keeps no
  // detail line to repeat the status.
  if (!neverSynced) {
    return localized;
  }
  return localized.map(metric =>
    Object.assign(metric, {
      value: UNMEASURED_VALUE,
      detail: '',
      tone: 'neutral' as const,
    })
  );
}

// The dashboard's own header, shared with the frame the entry paints while its
// config read answers: the same title, the same actions and the same reserved
// width, so a scope that lands here does not swap one header for another.
function DashboardHeader({
  scope,
  scopeTitle,
  canManage,
  pushOnce,
}: Readonly<{
  scope: string;
  scopeTitle: string;
  canManage: boolean;
  // The screen's one push guard. The header draws its actions but does not own
  // the hook: a second instance would guard the same presses with a second
  // state object and register a second focus reset.
  pushOnce: SinglePushRoute;
}>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
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
  );
}
// One placeholder tile per metric card the loaded grid shows, on the cards' own
// class and line boxes, so the grid that replaces them keeps every frame it
// painted. `neverSynced` decides whether a tile carries a detail line; a caller
// that cannot read the sync status yet lays out the synced shape, which is the
// one three of the four tiles carry in a scope that has synced.
function DashboardMetricTiles({ neverSynced }: Readonly<{ neverSynced: boolean }>) {
  return (
    <View className="flex-row flex-wrap gap-3">
      {STAT_TILE_PLACEHOLDERS.map(placeholder => (
        <View key={placeholder} className={STAT_TILE_CLASS}>
          {/* The loaded card's own line boxes: label, value, detail. */}
          <Skeleton className={cn('w-2/3', STAT_LABEL_LINE_CLASS)} />
          <Skeleton className={cn('w-1/2', STAT_VALUE_LINE_CLASS)} />
          {neverSynced ? null : <Skeleton className={cn('w-full', STAT_DETAIL_LINE_CLASS)} />}
        </View>
      ))}
    </View>
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

  // A precondition rejection describes server state this screen cannot change:
  // no repository in the sync scope, or a GitHub connection that is inactive or
  // missing the vulnerability-alerts permission. The fix is applied in the
  // repositories settings or on the GitHub App page, so the first return to
  // this screen is when the controls must work again. Both readings go through
  // refs so the focus callback and the handoff's return callback keep a stable
  // identity — a callback that changed whenever a failure arrived would re-run
  // the focus effect and clear the failure it had just shown.
  const triggerSyncRef = useRef(triggerSync);
  triggerSyncRef.current = triggerSync;
  const lastSyncAttemptRef = useRef(lastSyncAttempt);
  lastSyncAttemptRef.current = lastSyncAttempt;

  const clearSyncPreconditionFailure = useCallback(() => {
    const failure = triggerSyncRef.current.error ?? lastSyncAttemptRef.current?.error;
    if (securitySyncPreconditionFor(failure) === null) {
      return;
    }
    triggerSyncRef.current.reset();
    setLastSyncAttempt(null);
  }, []);

  // The GitHub preconditions' fix lives on the GitHub App page; this is the
  // app-wide handoff that mints the install state and waits for the return. A
  // handoff that never opened a page clears nothing: the copy still explains
  // what blocks the sync, and the handoff already reported its own failure.
  const handleHandoffReturn = useCallback(
    (opened: boolean) => {
      if (opened) {
        clearSyncPreconditionFailure();
      }
    },
    [clearSyncPreconditionFailure]
  );
  const manageAccess = useManageRepositoryAccess(scope, 'github', {
    onReturn: handleHandoffReturn,
  });

  // The dashboard stays mounted while the dismiss sheet is open, so re-read
  // the failed dismiss drafts on focus: a fresh failure must show a card and
  // an accepted dismissal must drop it. The same focus is the return from the
  // settings screen a precondition copy sends the reader to.
  useFocusEffect(
    useCallback(() => {
      refreshDismissFailures();
      refreshOutbox();
      clearSyncPreconditionFailure();
    }, [refreshDismissFailures, refreshOutbox, clearSyncPreconditionFailure])
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
  const syncFailure = triggerSync.error ?? lastSyncAttempt?.error ?? null;
  const syncPrecondition = securitySyncPreconditionFor(syncFailure);
  const syncBlocked = syncFailure !== null && !isSecuritySyncRetryable(syncFailure);
  // A sync outlives the request that started it. `syncWatch` marks a submit whose
  // command is still to be accounted for — accepted, or refused as already in
  // flight — and `syncRunning` is the server’s own view of the run, so the sync
  // control stays in a progress state for the whole sync instead of only for the
  // submission, and the refresh effect below fires when it ends.
  const [syncWatch, setSyncWatch] = useState<SyncWatch | null>(null);
  // Whether the run a watch points at was ever visible in the server’s list:
  // once it is, its disappearance ends the watch instead of the window.
  const sawSyncRun = useRef(false);
  const syncRunning = useSecurityAgentSyncRunning(scope, syncWatch !== null);
  const syncInFlight = triggerSync.isPending || syncWatch !== null || syncRunning.syncRunning;
  const syncDisabled = syncInFlight || syncBlocked;
  const syncRetryable = syncFailure !== null && isSecuritySyncRetryable(syncFailure);
  // The ledger’s in-progress conflict is not a failure of this sync: it is the
  // sync already running under the same operation key. It gets the running
  // presentation instead of a sentence with a Retry that would collide again.
  const syncFailureInProgress = syncFailure !== null && isSecuritySyncInProgress(syncFailure);

  // The run’s own read ends an accepted submit’s watch: a read taken after the
  // accept that reports no active sync command means the server has finished the
  // run, so the control returns to its normal state. A refused duplicate ends the
  // same way once the run it pointed at became visible; until then it waits for
  // the window below, because that run’s command may not exist yet. A read that
  // failed ends the watch too: silence is not evidence of progress, and holding
  // the control on an unreadable status would leave the screen with no way out.
  useEffect(() => {
    if (syncWatch === null || triggerSync.isPending) {
      return;
    }
    if (syncRunning.readFailedAt > syncWatch.at) {
      setSyncWatch(null);
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
  }, [
    syncWatch,
    triggerSync.isPending,
    syncRunning.syncRunning,
    syncRunning.updatedAt,
    syncRunning.readFailedAt,
  ]);

  // Whatever the watch was waiting for, the screen must give the controls back:
  // a refused duplicate’s submit settles inside the ledger’s window, and an
  // accepted submit’s command is listed the moment the Worker answers, so a run
  // this screen still cannot see after its own window is one it should stop
  // speaking for.
  useEffect(() => {
    if (syncWatch === null) {
      return () => undefined;
    }
    const window = syncWatch.duplicate ? DUPLICATE_SYNC_WATCH_MS : ACCEPTED_SYNC_WATCH_MS;
    const remaining = syncWatch.at + window - Date.now();
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

  // A finished sync changes what the dashboard shows — the last synced time and
  // the repository sync state — so refresh both without making the reader leave
  // and come back. The command observer invalidates the same queries for a
  // tracked command; this covers a run whose command this screen never tracked.
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
  // A precondition's fix is applied outside this screen, so the row offers that
  // action instead of a Retry that would fail the same way: the in-app
  // repository picker when nothing is in the sync scope, the GitHub App page
  // when the connection itself is what blocks the sync.
  let syncAction: { label: string; pending: boolean; handlePress: () => void } | null = null;
  if (syncPrecondition === 'noRepositories') {
    syncAction = {
      label: t('securityAgent.dashboard.manageRepositories'),
      pending: false,
      handlePress: () => {
        pushOnce(getSecurityAgentPath(scope, 'settings/repositories'));
      },
    };
  } else if (syncPrecondition !== null) {
    syncAction = {
      label: t('securityAgent.repositories.manageAccess'),
      pending: manageAccess?.pending === true,
      handlePress: () => {
        manageAccess?.handlePress();
      },
    };
  } else if (syncRetryable) {
    // The retry sits beside the sentence it retries and reports its own
    // progress: a failed sync can settle in a blink, so the header icon's flash
    // alone read as "nothing happened". It replays the intent that failed, not
    // the filter the reader may have switched to since.
    syncAction = {
      label: t('common.retry'),
      pending: triggerSync.isPending,
      handlePress: () => {
        startSync(lastSyncAttempt?.intent ?? { repoFullName });
      },
    };
  }

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
      <DashboardHeader
        scope={scope}
        scopeTitle={scopeTitle}
        canManage={canManage}
        pushOnce={pushOnce}
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
            {syncAction ? (
              <Button
                size="sm"
                variant="ghost"
                loading={syncAction.pending}
                // A busy non-primary control dims itself, spinner included,
                // which left the control the reader just pressed fainter than
                // the header icon spinning beside it.
                className={cn(syncAction.pending && 'opacity-100')}
                onPress={syncAction.handlePress}
              >
                <Text>{syncAction.label}</Text>
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
            metrics row. The sync-status read joins it because `neverSynced`
            decides whether a tile carries a detail line: a tile that rendered
            the measured shape first would shrink by a line the moment the read
            resolved, which moves the whole dashboard. The section cards join it
            for the same reason — they render below the tiles only once both
            reads settle — so their placeholders keep the page's height until
            then instead of letting the cards push it down. The placeholder
            takes that shape as soon as the read has answered it: a scope that
            has never synced replaces these tiles with two-line ones and its
            Act-first card with a single line, so laying out the synced shape
            over it would move everything below by a line whenever the stats
            read outlasts the sync-status read. While the read is still pending
            the detail line stays, because that is the shape three of the four
            tiles carry in a scope that has synced and the one a synced scope's
            first paint must not lose. */}
        {dashboardStats.isPending || lastSync.isPending ? (
          <View className="gap-4">
            <DashboardMetricTiles neverSynced={neverSynced} />
            {neverSynced && slaEnabled ? (
              // The Manage repositories link renders whenever SLA tracking is
              // on and nothing carries a deadline. Before the first sync that
              // is certain, so the placeholder holds the link's own inline
              // box and the sections below keep their place when the link
              // arrives. Once the tiles are measured the link needs a
              // measured total, which the placeholder cannot read, so a scope
              // that has synced keeps it out of the loading state.
              <View className="flex-row items-center gap-4">
                <Skeleton className={cn('w-32', INLINE_LINK_BOX_CLASS)} />
              </View>
            ) : null}
            <DashboardSectionsSkeleton slaEnabled={slaEnabled} neverSynced={neverSynced} />
          </View>
        ) : (
          <View className="flex-row flex-wrap gap-3">
            {metrics.map(metric => (
              <View key={metric.label} className={STAT_TILE_CLASS}>
                <Text variant="muted" className="text-xs">
                  {metric.label}
                </Text>
                <Text
                  className={cn(
                    'text-xl font-semibold tabular-nums',
                    METRIC_TONE_CLASS[metric.tone]
                  )}
                >
                  {metric.value}
                </Text>
                {metric.detail ? (
                  <Text variant="muted" className="text-[11px]">
                    {metric.detail}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        )}

        {slaEnabled && data && data.sla.overall.total === 0 ? (
          // The header’s Sync now button already starts this run, so the empty
          // state offers only the navigation it alone provides. It carries the
          // dashboard’s card language — the same surface and radius as the
          // sections below, at the same gap — because bare body text in the
          // section gap read as a stray label, not a tappable action. The label
          // takes the accent and a trailing chevron says it navigates.
          <Pressable
            onPress={() => {
              pushOnce(getSecurityAgentPath(scope, 'settings/repositories'));
            }}
            accessibilityRole="button"
            accessibilityLabel={t('securityAgent.dashboard.manageRepositories')}
            className={cn(
              ROW_TARGET_CLASS,
              'flex-row items-center justify-between gap-2 rounded-lg bg-secondary px-3 active:opacity-70'
            )}
          >
            <Text className="text-sm font-medium text-primary">
              {t('securityAgent.dashboard.manageRepositories')}
            </Text>
            <DirectionalChevronRight size={16} color={colors.primary} />
          </Pressable>
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

        {/* The Act first card's body depends on `neverSynced` too, so it waits
            for the sync-status read rather than swapping one shape for the
            other once the read resolves. */}
        {data && !lastSync.isPending ? (
          <DashboardSections
            scope={scope}
            data={data}
            slaEnabled={slaEnabled}
            repoFullName={repoFullName}
            neverSynced={neverSynced}
          />
        ) : null}
      </TabScreenScrollView>
    </View>
  );
}

// The frame a Security Agent entry paints while its config read is still
// unanswered. A scope that lands on the dashboard must not show a centered
// placeholder first: the header actions, the filter row and the tile frames are
// the layout the reader is about to get, so the loading frame keeps them and
// only the values wait. The filter names the loaded default and the sync
// control is the same 48 dp box in its disabled state, so neither moves when
// the reads answer.
export function DashboardLoadingView({ scope }: Readonly<{ scope: string }>) {
  const pushOnce = useSinglePushRoute();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const scopeTitle = useSecurityScopeTitle(scope);
  const capability = useSecurityAgentCapability(scope);
  return (
    <View className="flex-1 bg-background">
      <DashboardHeader
        scope={scope}
        scopeTitle={scopeTitle}
        canManage={capability.canManage}
        pushOnce={pushOnce}
      />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-6 gap-4"
        showsVerticalScrollIndicator={false}
      >
        <View className="flex-row items-center justify-between gap-3">
          <View className={cn(ROW_TARGET_CLASS, 'flex-1 justify-center')}>
            <Text className="text-sm font-medium" numberOfLines={1}>
              {t('common.allRepositories')}
            </Text>
            <Skeleton className="h-4 w-28 rounded" />
          </View>
          <IconButton
            disabled
            accessibilityLabel={t('securityAgent.dashboard.syncNow')}
            accessibilityState={{ disabled: true }}
          >
            <SpinningIcon
              icon={RefreshCw}
              size={18}
              color={colors.mutedForeground}
              spinning={false}
            />
          </IconButton>
        </View>
        <DashboardMetricTiles neverSynced={false} />
      </TabScreenScrollView>
    </View>
  );
}
