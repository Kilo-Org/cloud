import { formatDistance } from 'date-fns';
import { parseDbTimestamp } from '@/lib/feedback/timestamps';

/**
 * Human-readable relative time for a feedback submission ("3 days ago").
 * Takes `now` so the output is deterministic in tests.
 *
 * The `list` query normalizes `created_at` to UTC ISO. Accept the raw Postgres
 * `timestamptz` text shape too, so the formatter stays usable if a caller
 * passes a value straight from a `mode: 'string'` column.
 */
export function formatFeedbackTimestamp(value: string | null, now: Date = new Date()): string {
  const date = parseDbTimestamp(value);
  if (!date) return '';
  return formatDistance(date, now, { addSuffix: true });
}
