import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Parse a Drizzle `mode: 'string'` timestamp into a Date.
 * Hermes can't parse PostgreSQL's default format (`2026-03-13 14:30:00+00`),
 * so we normalise the space separator to `T` before parsing.
 */
function parseTimestamp(value: string): Date {
  // Date-only: "2026-09-26" → treat as UTC midnight
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00Z`);
  }
  // PostgreSQL: "2026-03-16 15:21:40.957+00" → need "T" separator and full tz offset "+00:00"
  const iso = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  return new Date(iso);
}

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

export { asyncNoop, cn, parseTimestamp, timeAgo };
