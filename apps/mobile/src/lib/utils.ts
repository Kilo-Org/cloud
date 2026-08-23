import { firstNonEmpty, formatDate, parseTimestamp } from '@kilocode/app-shared/utils';
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { i18n } from '@/i18n';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const EMAIL_PATTERN = /.+@.+\..+/;

// Ordered largest-first so the first unit whose bucket fits wins; the values
// mirror the original minute/hour/day/month/year buckets.
const RELATIVE_TIME_UNITS: readonly { unit: Intl.RelativeTimeFormatUnit; seconds: number }[] = [
  { unit: 'year', seconds: 365 * 24 * 60 * 60 },
  { unit: 'month', seconds: 30 * 24 * 60 * 60 },
  { unit: 'day', seconds: 24 * 60 * 60 },
  { unit: 'hour', seconds: 60 * 60 },
  { unit: 'minute', seconds: 60 },
];

/**
 * Returns a human-readable relative time string like "3 days ago". Uses
 * `Intl.RelativeTimeFormat` with the active i18n language (or the passed
 * locale) so the unit words and direction are localized. Sub-minute ages use
 * the catalog's `common.justNow` because RelativeTimeFormat has no sub-minute
 * bucket.
 */
function timeAgo(date: Date, locale?: string): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) {
    return i18n.t('common.justNow');
  }
  const resolvedLocale = locale ?? i18n.language;
  const formatter = new Intl.RelativeTimeFormat(resolvedLocale, { numeric: 'auto' });
  for (const { unit, seconds: unitSeconds } of RELATIVE_TIME_UNITS) {
    const value = Math.floor(seconds / unitSeconds);
    if (value >= 1) {
      return formatter.format(-value, unit);
    }
  }
  return i18n.t('common.justNow');
}

// eslint-disable-next-line no-empty-function -- intentional no-op
async function asyncNoop() {}

/** Builds a new object containing only the given keys of `obj`. */
function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const result: Partial<T> = {};
  for (const key of keys) {
    result[key] = obj[key];
  }
  return result as Pick<T, K>;
}

/** Uppercases the first letter, e.g. for enum-like values used as labels. */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export {
  asyncNoop,
  capitalize,
  cn,
  EMAIL_PATTERN,
  firstNonEmpty,
  formatDate,
  parseTimestamp,
  pick,
  timeAgo,
};
