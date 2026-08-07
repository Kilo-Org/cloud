import type { CodingPlanQuotaWindow } from '@/lib/coding-plans/usage-contract';
import { formatLocalDateTimeLabel } from '@/components/subscriptions/helpers';

const percentageFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

const LOW_REMAINING_PERCENT_THRESHOLD = 10;

export function formatCodingPlanQuotaPeriod(period: CodingPlanQuotaWindow['period']): string {
  return `${period.value}-${period.unit} window`;
}

export function formatCodingPlanRemainingPercent(remainingPercent: number): string {
  return `${percentageFormatter.format(remainingPercent)}%`;
}

export function formatCodingPlanQuotaReset(resetsAt: string): string {
  return formatLocalDateTimeLabel(resetsAt);
}

export function getCodingPlanQuotaDepletion(remainingPercent: number): number {
  return Math.min(100, Math.max(0, 100 - remainingPercent));
}

export function isCodingPlanQuotaLow(remainingPercent: number): boolean {
  return remainingPercent <= LOW_REMAINING_PERCENT_THRESHOLD;
}
