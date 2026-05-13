import { formatDollars, formatLargeNumber, fromMicrodollars } from '@/lib/utils';
import { formatMicrodollars } from '@/lib/admin-utils';
import type { MetricKey } from './types';

export function formatMetric(metric: MetricKey, value: number): string {
  switch (metric) {
    case 'cost':
      return formatDollars(fromMicrodollars(value));
    case 'requests':
      return formatLargeNumber(value);
    case 'tokens':
    case 'inputTokens':
    case 'outputTokens':
      return formatLargeNumber(value);
    case 'errorRate':
    case 'cacheHitRatio':
      return `${(value * 100).toFixed(1)}%`;
    case 'avgLatencyMs':
    case 'avgGenerationTimeMs': {
      if (value >= 1000) {
        return `${(value / 1000).toFixed(2)}s`;
      }
      return `${Math.round(value)}ms`;
    }
    case 'costPerRequest':
      return formatMicrodollars(value, 4);
    case 'tokensPerRequest':
      return Math.round(value).toLocaleString();
    case 'outputInputRatio':
      return `${value.toFixed(2)}x`;
  }
}

export function formatBytes(n: number): string {
  return formatLargeNumber(n);
}

export function formatPercentage(ratio: number, fractionDigits = 1): string {
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
}

export function formatDollarsFromMicrodollars(microdollars: number): string {
  return formatDollars(fromMicrodollars(microdollars));
}

/**
 * Converts a slug or snake/kebab-case identifier into a Title Case label.
 * E.g. `code-review` → `Code Review`, `smoke_mode` → `Smoke Mode`.
 */
export function humanize(value: string): string {
  if (!value) return value;
  return value
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
