export const DEFAULT_TTFB_THRESHOLD_MS = '3000';
export const DEFAULT_MIN_REQUESTS = '10';
export const DEFAULT_TTFB_SLO = '0.95';

export const SLO_OPTIONS = [
  { value: '0.50', label: 'p50' },
  { value: '0.95', label: 'p95' },
  { value: '0.99', label: 'p99' },
] as const;

export function formatMs(value: number): string {
  return `${Math.round(value).toLocaleString()}ms`;
}
