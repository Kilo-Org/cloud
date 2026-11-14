import { useQuery } from '@tanstack/react-query';
import { type Href, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { QueryError } from '@/components/query-error';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import { ScopeAccessDeniedScreen } from '@/components/organization/scope-access-denied-screen';
import { ConfigureRow } from '@/components/ui/configure-row';
import { FileText, GitPullRequest, LineChart, type LucideIcon } from '@/components/ui/icons';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { PERSONAL_SCOPE, PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
import { reviewerScopeTitle } from '@/lib/code-reviewer-scope-title';
import { useReviewerScopeName } from '@/lib/hooks/use-reviewer-scope-title';
import { classifyOrganizationScopeAccess } from '@/lib/organization-scope-access';
import { CODE_REVIEWER_HOME_PATH } from '@/lib/profile-agent-navigation';
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

type PeriodDays = 7 | 30 | 90;
type AnalyticsPlatform = 'github' | 'gitlab';

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
  const [period, setPeriod] = useState<PeriodDays>(30);
  const [platform, setPlatform] = useState<AnalyticsPlatform>('github');

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

  let body: ReactNode = null;
  if (dashboard.isPending) {
    body = <AnalyticsSkeleton />;
  } else if (dashboard.isError && !dashboard.data) {
    body = (
      <QueryError
        variant={trpcErrorVariant(dashboard.error)}
        title={t('codeReviewer.analytics.couldNotLoad')}
        onRetry={isRetryableTrpcError(dashboard.error) ? () => void dashboard.refetch() : undefined}
        isRetrying={dashboard.isFetching}
      />
    );
  } else {
    const { summary, repositories, settings } = dashboard.data;
    body = (
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
          // The muted note above already says analytics is off, so the generic
          // description would restate it.
          <EmptyState
            placement="static"
            icon={LineChart}
            title={t('codeReviewer.analytics.empty')}
            description={
              settings.enabled ? t('codeReviewer.analytics.emptyDescription') : undefined
            }
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
      <TabScreenScrollView className="flex-1" contentContainerClassName="gap-4 px-6 pt-4">
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
