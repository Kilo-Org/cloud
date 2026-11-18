import { useQuery } from '@tanstack/react-query';
import { type Href, useLocalSearchParams } from 'expo-router';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { QueryError } from '@/components/query-error';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import { ScopeAccessDeniedScreen } from '@/components/organization/scope-access-denied-screen';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Card } from '@/components/ui/card';
import { FileText, GitPullRequest, LineChart, type LucideIcon } from '@/components/ui/icons';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useCodeReviewerAnalyticsFilters } from '@/lib/hooks/use-code-reviewer-analytics-filters';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  PERSONAL_SCOPE,
  PLATFORM_CAPABILITIES,
  reviewerPlatformLabel,
} from '@/lib/code-reviewer-config';
import { reviewerScopeTitle } from '@/lib/code-reviewer-scope-title';
import { useReviewerScopeName } from '@/lib/hooks/use-reviewer-scope-title';
import { classifyOrganizationScopeAccess } from '@/lib/organization-scope-access';
import { CODE_REVIEWER_HOME_PATH } from '@/lib/profile-agent-navigation';
import { queryBodyFailure, useQueryBodyState } from '@/lib/hooks/use-query-body-state';
import { useTRPC } from '@/lib/trpc';
import { isRetryableTrpcError, trpcErrorVariant } from '@/lib/trpc-error';

/**
 * The day window the dashboard covers. The label is the day count and its unit
 * in one existing catalog string — the same three the usage screen paints for
 * the same windows — so a segment reads "30 days" instead of a bare number the
 * reader cannot attribute to days.
 */
const PERIOD_OPTIONS = [
  { value: '7', labelKey: 'spendAlerts.window7d' },
  { value: '30', labelKey: 'spendAlerts.window30d' },
  { value: '90', labelKey: 'usage.range90d' },
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
    <Card className="min-w-0 flex-1 justify-between gap-1">
      <View className="flex-row items-center gap-2">
        <Icon size={14} color={colors.mutedForeground} />
        <Text variant="muted" className="min-w-0 flex-1 text-xs" numberOfLines={2}>
          {label}
        </Text>
      </View>
      <Text variant="figure">{value}</Text>
    </Card>
  );
}

function AnalyticsSkeleton() {
  return (
    <View className="gap-6">
      <Skeleton className="h-10 w-full rounded-md bg-muted-soft" />
      <View className="gap-3">
        <View className="flex-row gap-3">
          <Card className="flex-1">
            <Skeleton className="h-3 w-20 max-w-full rounded bg-muted-soft" />
            <Skeleton className="h-7 w-16 max-w-full rounded bg-muted-soft" />
          </Card>
          <Card className="flex-1">
            <Skeleton className="h-3 w-20 max-w-full rounded bg-muted-soft" />
            <Skeleton className="h-7 w-16 max-w-full rounded bg-muted-soft" />
          </Card>
        </View>
        <View className="flex-row gap-3">
          <Card className="flex-1">
            <Skeleton className="h-3 w-20 max-w-full rounded bg-muted-soft" />
            <Skeleton className="h-7 w-16 max-w-full rounded bg-muted-soft" />
          </Card>
          <Card className="flex-1">
            <Skeleton className="h-3 w-20 max-w-full rounded bg-muted-soft" />
            <Skeleton className="h-7 w-16 max-w-full rounded bg-muted-soft" />
          </Card>
        </View>
      </View>
      <RowGroup leadingTile>
        {Array.from({ length: 2 }, (_, index) => (
          <RowSkeleton key={index} tile subtitle />
        ))}
      </RowGroup>
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

  // The organization's own name for the header, and the row a denial titles
  // itself with. The route already rejected the personal scope, so this read
  // always has an organization to look up.
  const organizations = useQuery(trpc.organizations.list.queryOptions());
  // The name this app last showed stands in once the reader loses the
  // membership, so the denial below still names the organization it is about.
  const knownScopeName = useReviewerScopeName(scope, organizations.data);
  const scopeTitle = reviewerScopeTitle(
    scope,
    organizations.data,
    {
      personal: t('common.personal'),
      organization: t('common.organization'),
    },
    knownScopeName
  );

  const dashboard = useQuery(
    trpc.codeReviews.analytics.getDashboard.queryOptions({
      organizationId: scope,
      platform,
      periodDays: period,
    })
  );

  // A denial is not a failed read: the reader cannot see this organization's
  // analytics at all, so the screen says so with the same surface the platform
  // list renders, and Retry re-resolves the membership a restored one lands.
  // Every other failure, and the cached data beside a failed refetch, keeps the
  // dashboard's own error state below.
  const access = classifyOrganizationScopeAccess({
    isOrganizationScope: true,
    errors: [dashboard.error],
  });

  // The dashboard read classifies through the shared body state: a read the
  // online manager pauses while the device is offline never reaches
  // react-query's error branch, so the screen would keep its skeleton forever.
  // The classifier names a confirmed pause as the offline state with Retry and
  // keeps an unsettled probe inside loading.
  const readState = useQueryBodyState({
    data: dashboard.data,
    isError: dashboard.isError,
    isFetching: dashboard.isFetching,
    fetchStatus: dashboard.fetchStatus,
    refetch: () => {
      void dashboard.refetch();
    },
  });
  const failure = queryBodyFailure(readState, dashboard.isFetching);

  const periodOptions = PERIOD_OPTIONS.map(option => ({
    value: option.value,
    label: t(option.labelKey),
  }));

  if (access !== 'granted') {
    return (
      <ScopeAccessDeniedScreen
        title={scopeTitle}
        // The denied header carries the granted header's identity: this
        // screen's own name over the organization, so a lost membership still
        // reads as the analytics screen the reader tried to open.
        eyebrow={t('codeReviewer.analytics.title')}
        backFallback={CODE_REVIEWER_HOME_PATH}
        kind={access}
        onRetry={() => {
          void Promise.allSettled([organizations.refetch(), dashboard.refetch()]);
        }}
        isRetrying={organizations.isFetching || dashboard.isFetching}
      />
    );
  }

  const number = (value: number) => formatNumber(value, i18n.language);

  // Cached metrics with a refresh that cannot run: the notice carries the
  // action that refreshes them, and it stays mounted while that retry runs, so
  // stale figures never pose as current without a way out.
  const stale = dashboard.data != null && (dashboard.isError || dashboard.fetchStatus === 'paused');
  const stalePaused = !dashboard.isError && dashboard.fetchStatus === 'paused';

  let body: ReactNode = null;
  if (failure) {
    // A paused read names itself offline; a failed one keeps its own tRPC
    // variant and offers Retry only for a retryable code.
    const failedVariant = stalePaused ? 'offline' : trpcErrorVariant(dashboard.error);
    body = (
      <QueryError
        variant={failedVariant}
        title={
          failedVariant === 'offline'
            ? t('queryError.offlineTitle')
            : t('codeReviewer.analytics.couldNotLoad')
        }
        onRetry={
          stalePaused || isRetryableTrpcError(dashboard.error)
            ? () => void dashboard.refetch()
            : undefined
        }
        isRetrying={failure.isRetrying}
      />
    );
  } else if (readState.body.status === 'loading' || dashboard.data === undefined) {
    body = <AnalyticsSkeleton />;
  } else {
    const { summary, repositories, settings, coverage } = dashboard.data;
    // Tracked counts only captured results, so the amount the reader's review
    // list shows but the dashboard does not count is every captured miss: the
    // capture is missing, its result failed validation, or it was omitted.
    const uncapturedReviews = coverage.missing + coverage.invalid + coverage.omitted;
    body = !settings.enabled ? (
      // Analytics is enabled per platform, so a disabled one is a state, not an
      // empty dataset: the zero stat cards and the generic empty state would
      // read as data the organization has none of. One EmptyState names the
      // platform whose setting is off and says where to turn it on; the
      // segment controls above stay so the reader can flip to the other
      // platform without leaving the screen.
      <EmptyState
        placement="center"
        // The scroll body already insets this state by the page gutter.
        inset="none"
        icon={LineChart}
        title={t('codeReviewer.analytics.offTitle', {
          platform: reviewerPlatformLabel(settings.platform),
        })}
        description={t('codeReviewer.analytics.offDescription')}
      />
    ) : (
      <View className="gap-6">
        {stale ? (
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
          <Text variant="muted" className="text-xs">
            {t('codeReviewer.analytics.trackedReviewsCaption')}
          </Text>
          {/* The line always renders, so a period or platform change never
          moves the list below it; at zero the count names the problem none. */}
          <Text variant="muted" className="text-xs">
            {t('codeReviewer.analytics.trackedReviewsUncounted', {
              count: uncapturedReviews,
              displayCount: number(uncapturedReviews),
              total: coverage.enrolledCompletedReviews,
              displayTotal: number(coverage.enrolledCompletedReviews),
            })}
          </Text>
        </View>

        {repositories.length === 0 ? (
          <EmptyState
            placement="static"
            icon={LineChart}
            title={t('codeReviewer.analytics.empty')}
            description={t('codeReviewer.analytics.emptyDescription')}
          />
        ) : (
          <Section label={t('common.repositories')}>
            <RowGroup leadingTile>
              {repositories.map(repository => (
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
                />
              ))}
            </RowGroup>
          </Section>
        )}
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ReviewerHeader
        title={scopeTitle}
        // One line, like the review list this scope also opens: the name arrives
        // with the membership read and a longer one tail-truncates inside the
        // same line instead of growing the header. The eyebrow keeps the
        // screen's own name there, since the organization name is user prose.
        titleNumberOfLines={1}
        eyebrow={t('codeReviewer.analytics.title')}
      />
      <TabScreenScrollView className="flex-1" contentContainerClassName={SCREEN_BODY_CLASS}>
        <View className="gap-2">
          <SegmentedControl
            options={PLATFORM_OPTIONS}
            value={platform}
            accessibilityLabel={t('common.platform')}
            onChange={setPlatform}
          />
          <SegmentedControl
            options={periodOptions}
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
        {body}
      </TabScreenScrollView>
    </View>
  );
}
