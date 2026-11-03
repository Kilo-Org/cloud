import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

/**
 * The counted severity buckets the Security Agent dashboard names. A line that
 * reports three counts at once cannot agree them from one `count`, so each
 * bucket is its own plural family that carries the number and the words that
 * agree with it; the line interpolates the finished phrases.
 */
export type SeverityCountBucket =
  | 'repoOpen'
  | 'repoCritical'
  | 'repoHigh'
  | 'breakdownCritical'
  | 'breakdownHigh'
  | 'breakdownMediumLow';

const BUCKET_KEYS = {
  repoOpen: 'securityAgent.dashboard.repoSummaryOpen',
  repoCritical: 'securityAgent.dashboard.repoSummaryCritical',
  repoHigh: 'securityAgent.dashboard.repoSummaryHigh',
  breakdownCritical: 'securityAgent.dashboardMetrics.breakdownCritical',
  breakdownHigh: 'securityAgent.dashboardMetrics.breakdownHigh',
  breakdownMediumLow: 'securityAgent.dashboardMetrics.breakdownMediumLow',
} satisfies Record<SeverityCountBucket, string>;

/** One bucket of a counted line: "1 crítica", "3 críticas", "0 de nível alto". */
export function severityCountPhrase(bucket: SeverityCountBucket, count: number): string {
  return i18n.t(BUCKET_KEYS[bucket], {
    count,
    displayCount: formatNumber(count, i18n.language),
  });
}
