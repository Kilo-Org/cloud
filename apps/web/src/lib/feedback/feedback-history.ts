import { formatDistance } from 'date-fns';

/**
 * Human-readable relative time for a feedback submission ("3 days ago").
 * Takes `now` so the output is deterministic in tests.
 *
 * The `list` query normalizes `created_at` to UTC ISO. Accept the raw Postgres
 * `timestamptz` text shape too, so the formatter stays usable if a caller
 * passes a value straight from a `mode: 'string'` column.
 */
export function formatFeedbackTimestamp(value: string | null, now: Date = new Date()): string {
  const iso = toIsoTimestamp(value);
  if (!iso) return '';
  return formatDistance(new Date(iso), now, { addSuffix: true });
}

/**
 * Normalize a Postgres `timestamptz` value to UTC ISO for the JSON boundary.
 * The driver returns text ("YYYY-MM-DD HH:MM:SS.sss+00"), which strict
 * validators reject. Return null for missing or invalid values.
 *
 * A string with no offset is rejected rather than parsed as server-local
 * time.
 */
export function toIsoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const iso = value.includes('T')
    ? value
    : value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso)) return null;
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}
