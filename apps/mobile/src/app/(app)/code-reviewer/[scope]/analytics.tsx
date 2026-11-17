import { useQuery } from '@tanstack/react-query';
import { type Href, useLocalSearchParams } from 'expo-router';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { QueryError } from '@/components/query-error';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { FileText, GitPullRequest, LineChart, type LucideIcon } from '@/components/ui/icons';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { isRetryableTrpcError, trpcErrorVariant } from '@/lib/trpc-error';
import { useCodeReviewerAnalyticsFilters } from '@/lib/hooks/use-code-reviewer-analytics-filters';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { PERSONAL_SCOPE, PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
import { queryBodyFailure, useQueryBodyState } from '@/lib/hooks/use-query-body-state';
import { useTRPC } from '@/lib/trpc';

const PERIOD_OPTIONS = [
  { value: '7', label: '7' },
  { value: '30', label: '30' },
  { value: '90', label: '90' },
] as const;

const PLATFORM_OPTIONS = (['github', 'gitlab'] as const).map(platform => ({
  value: platform,
  label: PLATFORM_CAPABILITIES[platform].label,
}));

function MetricCard({
  icon: Icon,
  label,
  value,
}: Readonly<{ icon: LucideIcon; label: string; value: string }>) {
  const colors = useThemeColors();
  return (
    <View className="min-w-0 flex-1 justify-center gap-1 rounded-lg bg-secondary p-4">
      <View className="flex-row items-center gap-2">
        <Icon size={14} color={colors.mutedForeground} />
        <Text variant="muted" className="min-w-0 flex-1 text-xs" numberOfLines={2}>
          {label}
        </Text>
      </View>
      <Text className="text-lg font-semibold">{value}</Text>
    </View>
  );
}

function AnalyticsSkeleton() {
  return (
    <View className="gap-3 px-6 pt-4">
      <Skeleton className="h-10 w-full rounded-lg" />
      <View className="flex-row gap-3">
        <Skeleton className="h-20 flex-1 rounded-lg" />
        <Skeleton className="h-20 flex-1 rounded-lg" />
      </View>
      <View className="flex-row gap-3">
        <Skeleton className="h-20 flex-1 rounded-lg" />
        <Skeleton className="h-20 flex-1 rounded-lg" />
      </View>
      <Skeleton className="h-12 w-full rounded-lg" />
      <Skeleton className="h-12 w-full rounded-lg" />
    </View>
  );
}

export default function CodeReviewerAnalyticsRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  if (!scope || scope === PERSONAL_SCOPE) {
    return <InvalidRouteState backTo={'/(app)/code-reviewer' as Href} />;
  }
  return <AnalyticsScreen scope={scope} />;
}

function AnalyticsScreen({ scope }: Readonly<{ scope: string }>) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const { platform, period, setPlatform, setPeriod } = useCodeReviewerAnalyticsFilters(scope);

  const dashboard = useQuery(
    trpc.codeReviews.analytics.getDashboard.queryOptions({
      organizationId: scope,
      platform,
      periodDays: period,
    })
  );

  const number = (value: number) => formatNumber(value, i18n.language);

  // The dashboard read settles only when it can send: on the default online
  // network mode, an offline device keeps it `pending` with `fetchStatus:
  // 'paused'`, which the old branch map reported as the skeleton forever —
  // no error, no Retry (finding: blank analytics offline). The config
  // classifier owns this split for the reviewer screens: a pause whose
  // connectivity the app has confirmed names itself as the offline state with
  // Retry, and a pause while connectivity is still unsettled stays the
  // skeleton. A cached dashboard with a refetch that is now paused or failed
  // keeps the metrics and gains the stale-notice line, so stale rows never
  // pose as current without a way out.
  const body = useQueryBodyState({
    data: dashboard.data,
    isError: dashboard.isError,
    isFetching: dashboard.isFetching,
    fetchStatus: dashboard.fetchStatus,
    refetch: () => {
      void dashboard.refetch();
    },
  });
  const failure = queryBodyFailure(body, dashboard.isFetching);
  // Cached metrics with a refresh that cannot run: the classifier reports
  // `ready` the moment data exists, so the notice comes from the read itself —
  // paused (connectivity lost) or failed (the refetch errored). The brief for
  // this finding names both: rows stay, the reader learns they are stale and
  // gets the action that refreshes them. The notice is not gated on
  // `!isFetching`, or a Retry would unmount the surface it is running on.
  const stale = dashboard.data != null && (dashboard.isError || dashboard.fetchStatus === 'paused');

  let content: ReactNode = null;
  if (!failure && body.body.status === 'ready' && dashboard.data) {
    const { summary, repositories, settings } = dashboard.data;
    content = (
      <View className="gap-6 px-6 pt-4">
        {!settings.enabled ? (
          <Text variant="muted" className="text-xs">
            {t('codeReviewer.analytics.off')}
          </Text>
        ) : null}
        <View className="gap-3">
          <View className="flex-row gap-3">
            <MetricCard
              icon={GitPullRequest}
              label={t('codeReviewer.analytics.trackedReviews')}
              value={number(summary.trackedReviews)}
            />
            <MetricCard
              icon={FileText}
              label={t('codeReviewer.analytics.findingsRaised')}
              value={number(summary.totalFindings)}
            />
          </View>
          <View className="flex-row gap-3">
            <MetricCard
              icon={LineChart}
              label={t('codeReviewer.analytics.highImpactChanges')}
              value={number(summary.highImpactChanges)}
            />
            <MetricCard
              icon={LineChart}
              label={t('codeReviewer.analytics.impactPoints')}
              value={number(summary.estimatedImpactPoints)}
            />
          </View>
        </View>

        {repositories.length === 0 ? (
          <EmptyState
            placement="static"
            icon={LineChart}
            title={t('codeReviewer.analytics.empty')}
            description={t('codeReviewer.analytics.emptyDescription')}
          />
        ) : (
          <View className="gap-2">
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              {t('common.repositories')}
            </Text>
            <View>
              {repositories.map((repository, index) => (
                <ConfigureRow
                  key={repository.repository}
                  icon={GitPullRequest}
                  title={repository.repository}
                  subtitle={t('codeReviewer.analytics.repositoryLine', {
                    reviews: number(repository.trackedPrsOrMrs),
                    findings: number(
                      repository.criticalFindings +
                        repository.warningFindings +
                        repository.suggestionFindings
                    ),
                  })}
                  last={index === repositories.length - 1}
                />
              ))}
            </View>
          </View>
        )}
      </View>
    );
  }

  let readState: ReactNode = null;
  if (failure) {
    // A permanent code (denial, not found) keeps its own variant and no Retry:
    // the classifier folds every error into `server`, so the thrown error's
    // own tRPC variant decides the surface when the read failed rather than
    // paused.
    const failedVariant = dashboard.isError ? trpcErrorVariant(dashboard.error) : failure.variant;
    const failedTitle =
      failedVariant === 'offline'
        ? t('queryError.offlineTitle')
        : t('codeReviewer.analytics.couldNotLoad');
    const failedRetryable = dashboard.isError ? isRetryableTrpcError(dashboard.error) : true;
    readState = (
      <QueryError
        variant={failedVariant}
        placement="top"
        className="px-0 pt-0"
        title={failedTitle}
        onRetry={failedRetryable ? () => void dashboard.refetch() : undefined}
        isRetrying={failure.isRetrying}
      />
    );
  } else if (body.body.status === 'loading') {
    readState = <AnalyticsSkeleton />;
  } else if (stale) {
    // The metrics stay, so the notice carries the action that refreshes them:
    // a pause always offers Retry, while a permanent code keeps its own
    // variant and no Retry. The notice stays mounted while that Retry runs, so
    // `isRetrying` reports the read rather than disappearing with it.
    const stalePaused = !dashboard.isError && dashboard.fetchStatus === 'paused';
    readState = (
      <QueryError
        variant={stalePaused ? 'offline' : trpcErrorVariant(dashboard.error)}
        placement="top"
        className="px-0 pt-0"
        title={stalePaused ? t('queryError.offlineTitle') : t('common.somethingWentWrong')}
        onRetry={
          stalePaused || isRetryableTrpcError(dashboard.error)
            ? () => void dashboard.refetch()
            : undefined
        }
        isRetrying={dashboard.isFetching}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ReviewerHeader
        title={t('codeReviewer.analytics.title')}
        eyebrow={t('common.codeReviewer')}
      />
      <TabScreenScrollView className="flex-1" contentContainerClassName="gap-4 px-6 pt-4">
        <View className="gap-2">
          <SegmentedControl
            options={PLATFORM_OPTIONS}
            value={platform}
            accessibilityLabel={t('common.platform')}
            onChange={setPlatform}
          />
          <SegmentedControl
            options={PERIOD_OPTIONS}
            value={String(period)}
            accessibilityLabel={t('usage.rangePicker')}
            onChange={value => {
              const next = Number(value);
              if (next === 7 || next === 30 || next === 90) {
                setPeriod(next);
              }
            }}
          />
        </View>
        {/* One body surface below the filters: a paused or failed first load
            paints the classifier's offline/server state with Retry instead of
            the skeleton that would never settle; cached metrics keep their
            content and report a refresh that is paused or failed with an
            actionable notice above them. */}
        {readState}
        {content}
      </TabScreenScrollView>
    </View>
  );
}
