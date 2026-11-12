import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { LineChart } from '@/components/ui/icons';
import { formatNumber } from '@/lib/format';
import {
  type UsageMetric,
  type UsageScope,
  useUsageAnalytics,
} from '@/lib/hooks/use-usage-analytics';
import { type UsageRange } from '@/lib/hooks/usage-window';
import { isolateLtrBidiText } from '@/lib/bidi';

import { UsageBarChart } from './usage-bar-chart';
import { UsageBreakdownList } from './usage-breakdown-list';
import { formatUsageCost, formatUsageCostPrecise } from './usage-format';

const RANGE_OPTIONS = [
  { value: '7d', labelKey: 'spendAlerts.window7d' },
  { value: '30d', labelKey: 'spendAlerts.window30d' },
  { value: '90d', labelKey: 'usage.range90d' },
] as const;

/**
 * The metric options reuse the labels the rest of the app already gives these
 * three measures, so "Cost" here is the same word the credits card uses.
 */
const METRIC_OPTIONS = [
  { value: 'cost', labelKey: 'common.cost' },
  { value: 'requests', labelKey: 'organization.usageStats.requests' },
  { value: 'tokens', labelKey: 'codeReviewer.reviewDetail.tokens' },
] as const;

function StatTile({
  label,
  value,
  subtext,
}: Readonly<{
  label: string;
  value: string;
  subtext?: string;
}>) {
  return (
    <View className="flex-1 gap-1 rounded-lg bg-secondary px-3 py-3">
      <Text className="text-lg font-bold text-foreground">{value}</Text>
      {subtext !== undefined && (
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {subtext}
        </Text>
      )}
      <Text className="text-xs text-muted-foreground">{label}</Text>
    </View>
  );
}

/**
 * The usage screen's body for one scope. Totals, a daily chart and the cost
 * leaders per model and per feature — the three questions web's usage page
 * answers, without its tables, filters or CSV export.
 */
export function UsageContent({ scope }: Readonly<{ scope: UsageScope }>) {
  const { t, i18n } = useTranslation();
  const [range, setRange] = useState<UsageRange>('30d');
  const [metric, setMetric] = useState<UsageMetric>('cost');
  const usage = useUsageAnalytics(scope, range, metric);

  const rangeOptions = RANGE_OPTIONS.map(option => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const metricOptions = METRIC_OPTIONS.map(option => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const metricLabel = metricOptions.find(option => option.value === metric)?.label ?? '';

  const summary = usage.summary;
  const empty = summary?.requestCount === 0;
  // No totals at all: the screen has nothing to show but the failure.
  const failed = usage.isSummaryError && summary === undefined;
  const loading = summary === undefined && !failed;
  // Totals loaded, but a refresh of them failed: keep the numbers and flag them
  // instead of presenting stale data as current.
  const staleTotals = usage.isSummaryError && summary !== undefined;
  const retryAll = () => {
    usage.refetch();
  };

  return (
    <View className="gap-6">
      <View className="gap-2">
        <SegmentedControl
          options={rangeOptions}
          value={range}
          onChange={setRange}
          accessibilityLabel={t('usage.rangePicker')}
        />
        {scope.kind === 'organization' && !scope.orgWide && (
          <Text className="text-xs text-muted-foreground">{t('usage.orgSelfNotice')}</Text>
        )}
      </View>

      {failed && (
        <QueryError
          variant={usage.isPaused ? 'offline' : 'neutral'}
          onRetry={retryAll}
          isRetrying={usage.isFetching}
          placement="top"
        />
      )}

      {staleTotals && (
        <QueryError
          variant={usage.isPaused ? 'offline' : 'neutral'}
          onRetry={retryAll}
          isRetrying={usage.isFetching}
          placement="top"
        />
      )}

      {loading && (
        <View className="gap-6">
          <View className="gap-3">
            <View className="flex-row gap-3">
              <Skeleton className="h-[76px] flex-1 rounded-lg bg-muted-soft" />
              <Skeleton className="h-[76px] flex-1 rounded-lg bg-muted-soft" />
            </View>
            <View className="flex-row gap-3">
              <Skeleton className="h-[76px] flex-1 rounded-lg bg-muted-soft" />
              <Skeleton className="h-[76px] flex-1 rounded-lg bg-muted-soft" />
            </View>
          </View>
          <Skeleton className="h-[148px] w-full rounded-lg bg-muted-soft" />
        </View>
      )}

      {!loading && !failed && empty && (
        <EmptyState icon={LineChart} title={t('usage.emptyTitle')} placement="static" />
      )}

      {!loading && !failed && summary !== undefined && !empty && (
        <>
          <View className="gap-3">
            <View className="flex-row gap-3">
              <StatTile
                label={t('common.cost')}
                value={isolateLtrBidiText(formatUsageCost(summary.costMicrodollars, i18n.language))}
              />
              <StatTile
                label={t('organization.usageStats.requests')}
                value={formatNumber(summary.requestCount, i18n.language)}
              />
            </View>
            <View className="flex-row gap-3">
              <StatTile
                label={t('codeReviewer.reviewDetail.tokens')}
                value={formatNumber(summary.totalTokens, i18n.language, {
                  notation: 'compact',
                  maximumFractionDigits: 1,
                })}
                subtext={t('codeReviewer.reviewDetail.tokensInOut', {
                  input: formatNumber(summary.inputTokens, i18n.language, {
                    notation: 'compact',
                    maximumFractionDigits: 1,
                  }),
                  output: formatNumber(summary.outputTokens, i18n.language, {
                    notation: 'compact',
                    maximumFractionDigits: 1,
                  }),
                })}
              />
              <StatTile
                label={t('usage.avgCostPerRequest')}
                value={isolateLtrBidiText(
                  formatUsageCostPrecise(summary.costPerRequest, i18n.language)
                )}
              />
            </View>
          </View>

          <View className="gap-3">
            <SegmentedControl
              options={metricOptions}
              value={metric}
              onChange={setMetric}
              accessibilityLabel={t('usage.metricPicker')}
            />
            {usage.isSeriesError ? (
              <QueryError
                variant={usage.isPaused ? 'offline' : 'neutral'}
                onRetry={retryAll}
                isRetrying={usage.isFetching}
              />
            ) : (
              <UsageBarChart
                points={usage.points ?? []}
                accessibilityLabel={t('usage.chartA11y', { metric: metricLabel })}
              />
            )}
          </View>

          {usage.isBreakdownError ? (
            <QueryError
              variant={usage.isPaused ? 'offline' : 'neutral'}
              onRetry={retryAll}
              isRetrying={usage.isFetching}
            />
          ) : (
            <>
              <UsageBreakdownList title={t('usage.topModels')} entries={usage.models ?? []} />
              <UsageBreakdownList
                title={t('usage.topFeatures')}
                entries={usage.features ?? []}
                humanize
              />
            </>
          )}
        </>
      )}
    </View>
  );
}
