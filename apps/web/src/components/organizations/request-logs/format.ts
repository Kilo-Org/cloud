import { fromMicrodollars } from '@kilocode/app-shared/utils';

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function formatMicrodollarsAsUsd(microdollars: number): string {
  return usdFormatter.format(fromMicrodollars(microdollars));
}

export function formatRequestTime(isoTimestamp: string): string {
  return timeFormatter.format(new Date(isoTimestamp));
}

export function formatCount(value: number): string {
  return value.toLocaleString();
}

export function formatDurationMs(milliseconds: number | null): string {
  if (milliseconds === null) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(2)} s`;
}
