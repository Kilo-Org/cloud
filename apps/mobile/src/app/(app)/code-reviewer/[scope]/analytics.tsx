import { useQuery } from '@tanstack/react-query';
import { type Href, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useState } from 'react';
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
import { PERSONAL_SCOPE, PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
import { useTRPC } from '@/lib/trpc';
import { isRetryableTrpcError, trpcErrorVariant } from '@/lib/trpc-error';

const PERIOD_OPTIONS = [
  { value: '7', label: '7' },
  { value: '30', label: '30' },
  { value: '90', label: '90' },
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
  return (
    <View className="min-w-0 flex-1 gap-1 rounded-lg bg-secondary p-4">
      <View className="flex-row items-center gap-2">
        <Icon size={14} className="text-muted-foreground" />
        <Text variant="muted" className="text-xs" numberOfLines={2}>
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

  const dashboard = useQuery(
    trpc.codeReviews.analytics.getDashboard.queryOptions({
      organizationId: scope,
      platform,
      periodDays: period,
    })
  );

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
            accessibilityLabel={t('codeReviewer.analytics.period')}
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
