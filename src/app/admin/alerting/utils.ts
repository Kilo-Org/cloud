export const DEFAULT_ERROR_RATE_PERCENT = '0.10';
export const DEFAULT_MIN_REQUESTS = '10';

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function toErrorRateSlo(errorRatePercent: number): number {
  return 1 - errorRatePercent / 100;
}
