'use client';
import { MetricSelector } from '../MetricSelector';
import { PrimaryChartView } from '../PrimaryChartView';
import type { AIAdoptionChartProps } from './AIAdoptionChart';
import { AIAdoptionChart } from './AIAdoptionChart';
import type { TimeseriesDataPoint, ChartSplitBy } from '../types';

type Metric = {
  key: string;
  title: string;
  value: string | React.ReactNode;
  chartType: 'line' | 'bar';
  data: [number[], number[]];
  icon?: React.ComponentType<{ className?: string }>;
  color?: string;
  loading?: boolean;
};

type MetricsSectionProps = {
  metrics: Metric[];
  selectedMetric: string;
  onMetricChange: (metric: string) => void;
  timeseriesData: TimeseriesDataPoint[];
  chartSplitBy: ChartSplitBy;
  onChartSplitByChange: (value: ChartSplitBy) => void;
  className?: string;
  organizationId: string;
} & AIAdoptionChartProps;

/**
 * Combined metrics selector and primary chart view.
 *
 * This component groups the metric cards and the main chart together
 * as they form a logical unit that's always displayed together.
 */
export function MetricsSection({
  adoption,
  metrics,
  selectedMetric,
  onMetricChange,
  timeseriesData,
  chartSplitBy,
  onChartSplitByChange,
  className = '',
  organizationId,
}: MetricsSectionProps) {
  const selectedMetricData = metrics.find(m => m.key === selectedMetric);

  return (
    <div className={className}>
      {/* AI Adoption Score Chart */}
      <AIAdoptionChart adoption={adoption} organizationId={organizationId} />

      <div className="mt-6">
        <MetricSelector
          metrics={metrics}
          selectedMetric={selectedMetric}
          onSelectedMetricChange={onMetricChange}
        />
      </div>

      <PrimaryChartView
        selectedMetric={selectedMetricData}
        timeseriesData={timeseriesData}
        className="mt-8"
        chartSplitBy={chartSplitBy}
        onChartSplitByChange={onChartSplitByChange}
      />
    </div>
  );
}
