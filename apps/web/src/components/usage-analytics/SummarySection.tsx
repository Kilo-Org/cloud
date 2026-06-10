'use client';
import { Activity, Calculator, DollarSign, Hash, Users } from 'lucide-react';
import { MetricCard } from './MetricCard';
import { formatMetric } from './format';
import { formatLargeNumber } from '@/lib/utils';
import type { CostSource, UsageSummary } from './types';

type SummarySectionProps = {
  summary: UsageSummary | undefined;
  loading: boolean;
  costSource: CostSource;
  /** Show the Active Users card (organization context only). */
  showActiveUsers?: boolean;
};

/**
 * Compact single-row of primary cost/usage metrics.
 *
 * Renders 4 cards for personal context, 5 cards for organization context
 * (with Active Users). The tokens card shows total tokens with an
 * "{input} in / {output} out" subtext.
 */
export function SummarySection({
  summary,
  loading,
  costSource,
  showActiveUsers,
}: SummarySectionProps) {
  const costTitle = costSource === 'market' ? 'Est. Market Cost' : 'Cost';
  const averageCostTitle = costSource === 'market' ? 'Avg Market / Req' : 'Avg Cost / Req';
  const tokensSubtext = summary
    ? `${formatLargeNumber(summary.inputTokens, true)} in / ${formatLargeNumber(summary.outputTokens, true)} out`
    : undefined;

  const gridColsClass = showActiveUsers
    ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5'
    : 'grid grid-cols-2 gap-3 sm:grid-cols-4';

  return (
    <div className={gridColsClass}>
      <MetricCard
        title={costTitle}
        value={summary ? formatMetric('cost', summary.costMicrodollars) : '—'}
        icon={DollarSign}
        loading={loading}
      />
      <MetricCard
        title="Requests"
        value={summary ? formatMetric('requests', summary.requestCount) : '—'}
        icon={Activity}
        loading={loading}
      />
      <MetricCard
        title={averageCostTitle}
        value={summary ? formatMetric('costPerRequest', summary.costPerRequest) : '—'}
        icon={Calculator}
        loading={loading}
      />
      <MetricCard
        title="Tokens"
        value={summary ? formatMetric('tokens', summary.totalTokens) : '—'}
        icon={Hash}
        loading={loading}
        subtext={tokensSubtext}
      />
      {showActiveUsers && (
        <MetricCard
          title="Active Users"
          value={summary ? formatLargeNumber(summary.distinctUsers) : '—'}
          icon={Users}
          loading={loading}
        />
      )}
    </div>
  );
}
