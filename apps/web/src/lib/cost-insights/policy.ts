export const MICRODOLLARS_PER_USD = 1_000_000;
export const MICRODOLLARS_PER_CENT = 10_000;

export const COST_INSIGHT_ANOMALY_MULTIPLIER = 3;
export const COST_INSIGHT_ANOMALY_FLOOR_MICRODOLLARS = 10 * MICRODOLLARS_PER_USD;
export const COST_INSIGHT_STARTER_ANOMALY_FLOOR_MICRODOLLARS = 25 * MICRODOLLARS_PER_USD;
export const COST_INSIGHT_MIN_BASELINE_BUCKETS = 24;

const THRESHOLD_USD_PATTERN = /^(?:0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

export type CostInsightBaselineMode = 'starter' | 'available-history' | 'seven-day';

export type CostInsightAnomalyPolicy = {
  baselineMicrodollars: number;
  thresholdMicrodollars: number;
  baselineBucketCount: number;
  mode: CostInsightBaselineMode;
};

export function microdollarsToUsd(microdollars: number): number {
  return microdollars / MICRODOLLARS_PER_USD;
}

export function usdToMicrodollarsFromCents(cents: number): number {
  return cents * MICRODOLLARS_PER_CENT;
}

export function parseSpendThresholdUsd(value: string | null): number | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return null;
  const match = THRESHOLD_USD_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error('Spend threshold must be a positive USD amount with cents precision.');
  }

  const [wholePart, centsPart = ''] = trimmed.split('.');
  const dollars = Number.parseInt(wholePart, 10);
  const cents = Number.parseInt(centsPart.padEnd(2, '0') || '0', 10);
  const totalCents = dollars * 100 + cents;
  if (totalCents <= 0) {
    throw new Error('Spend threshold must be greater than $0.00.');
  }
  if (!Number.isSafeInteger(totalCents)) {
    throw new Error('Spend threshold is too large. Enter a smaller USD amount.');
  }

  const totalMicrodollars = usdToMicrodollarsFromCents(totalCents);
  try {
    return requireSafeMicrodollars(totalMicrodollars, 'Spend threshold');
  } catch {
    throw new Error('Spend threshold is too large. Enter a smaller USD amount.');
  }
}

export function formatSpendThresholdUsd(value: number | null): string {
  if (value === null) return '';
  const cents = Math.round(value / MICRODOLLARS_PER_CENT);
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  return `${dollars}.${String(remainder).padStart(2, '0')}`;
}

export function requireSafeMicrodollars(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive safe integer.`);
  }
  return value;
}

export function percentileNearestRank(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? 0;
}

export function calculateAnomalyPolicy(values: number[]): CostInsightAnomalyPolicy {
  const baselineBucketCount = values.length;
  if (baselineBucketCount < COST_INSIGHT_MIN_BASELINE_BUCKETS) {
    return {
      baselineMicrodollars: 0,
      thresholdMicrodollars: COST_INSIGHT_STARTER_ANOMALY_FLOOR_MICRODOLLARS,
      baselineBucketCount,
      mode: 'starter',
    };
  }

  const baselineMicrodollars = percentileNearestRank(values, 95);
  const thresholdMicrodollars = Math.max(
    baselineMicrodollars * COST_INSIGHT_ANOMALY_MULTIPLIER,
    COST_INSIGHT_ANOMALY_FLOOR_MICRODOLLARS
  );
  return {
    baselineMicrodollars,
    thresholdMicrodollars,
    baselineBucketCount,
    mode: baselineBucketCount >= 24 * 7 ? 'seven-day' : 'available-history',
  };
}

export function floorUtcHour(date: Date): string {
  const timestamp = Math.floor(date.getTime() / 3_600_000) * 3_600_000;
  return new Date(timestamp).toISOString();
}

export function addHours(timestamp: string, hours: number): string {
  return new Date(Date.parse(timestamp) + hours * 3_600_000).toISOString();
}

export function addDays(timestamp: string, days: number): string {
  return addHours(timestamp, days * 24);
}
