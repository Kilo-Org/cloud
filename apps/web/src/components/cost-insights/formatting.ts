import type { SpendDriver, SpendRange } from './types';

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const wholeDollarFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export const sourceLabels = {
  ai_gateway: 'AI usage',
  kiloclaw: 'KiloClaw',
  coding_plan: 'Coding Plan',
  other: 'Other',
} satisfies Record<SpendDriver['source'], string>;

const spendRangePeriodLabels = {
  '1h': 'the current hour',
  '24h': 'the last 24 hours',
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
  '90d': 'the last 90 days',
} satisfies Record<SpendRange, string>;

export function spendRangePeriodLabel(range: SpendRange) {
  return spendRangePeriodLabels[range];
}

export function money(value: number) {
  return (value >= 100 ? wholeDollarFormatter : currencyFormatter).format(value);
}

export function formatCostInsightDateTime(timestamp: string, timeZone?: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(timestamp));
}

export function formatSpendEvidenceTime(
  timestamp: string,
  range: '1h' | '24h' | '7d',
  timeZone?: string
) {
  return new Intl.DateTimeFormat('en-US', {
    ...(range === '7d' ? { month: 'short', day: 'numeric' } : {}),
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(timestamp));
}

export function formatCostInsightHourWindow(
  startTimestamp: string,
  endTimestampExclusive: string,
  timeZone?: string
) {
  const start = new Date(startTimestamp);
  const end = new Date(new Date(endTimestampExclusive).getTime() - 1);
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(start);
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  });

  return `${dateLabel}, ${timeFormatter.format(start)}-${timeFormatter.format(end)}`;
}

export function formatCostInsightElapsedWindow(
  startTimestamp: string,
  endTimestampExclusive: string,
  timeZone?: string
) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  });
  return `${formatter.format(new Date(startTimestamp))}-${formatter.format(
    new Date(endTimestampExclusive)
  )}`;
}

export function percentOf(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

export function spendBarHeightPercent(value: number, maximum: number) {
  if (value <= 0 || maximum <= 0) return 0;
  return Math.max(2, percentOf(value, maximum));
}
