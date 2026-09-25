import { formatDistance } from 'date-fns';

/**
 * Parse a Postgres `timestamptz` text value.
 *
 * The driver returns these as `"YYYY-MM-DD HH:MM:SS.sss+00"`, which is not
 * ISO-8601 and is parsed inconsistently across browsers. Normalize the space
 * separator and a bare two-digit offset first; return null for anything that
 * still does not parse so callers can omit the label instead of rendering
 * "Invalid Date".
 */
export function parseFeedbackTimestamp(value: string): Date | null {
  if (!value) return null;
  const iso = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Human-readable relative time for a feedback submission ("3 days ago").
 * Takes `now` so the output is deterministic in tests.
 */
export function formatFeedbackTimestamp(iso: string, now: Date = new Date()): string {
  const date = parseFeedbackTimestamp(iso);
  if (!date) return '';
  return formatDistance(date, now, { addSuffix: true });
}
