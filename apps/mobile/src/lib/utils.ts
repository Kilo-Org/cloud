import { firstNonEmpty, formatDate, parseTimestamp } from '@kilocode/app-shared/utils';
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const EMAIL_PATTERN = /.+@.+\..+/;

/** Returns a human-readable relative time string like "3 days ago". */
function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo ago`;
  }
  const years = Math.floor(days / 365);
  return `${years}y ago`;
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
