import { formatDistance } from 'date-fns';

/**
 * Human-readable relative time for a feedback submission ("3 days ago").
 * Takes `now` so the output is deterministic in tests.
 *
 * The `list` query returns `created_at` as UTC ISO. Older rows may still
 * carry raw Postgres `timestamptz` text, so accept that shape too.
 */
export function formatFeedbackTimestamp(value: string | null, now: Date = new Date()): string {
  const date = parseFeedbackTimestamp(value);
  if (!date) return '';
  return formatDistance(date, now, { addSuffix: true });
}

function parseFeedbackTimestamp(value: string | null): Date | null {
  if (!value) return null;
  // Postgres `timestamptz` text is "YYYY-MM-DD HH:MM:SS.sss+00", which is
  // not ISO-8601. Normalize before parsing. A string with no offset is
  // rejected rather than parsed as local time.
  const iso = value.includes('T')
    ? value
    : value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
