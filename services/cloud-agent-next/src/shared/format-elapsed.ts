/**
 * Human-readable elapsed-time formatting for session and execution logs.
 *
 * Log lines currently hand-roll `${minutes}m ${seconds}s` in several places;
 * this centralizes the arithmetic so the rendering stays consistent.
 */

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * Render a duration in milliseconds as a compact `1h 2m 3s` string.
 *
 * Units that are zero are omitted, except that a sub-second duration still
 * renders as `0s` so callers always get a non-empty label.
 */
export function formatElapsed(durationMs: number): string {
  const hours = Math.floor(durationMs / MS_PER_HOUR);
  const minutes = Math.floor((durationMs % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((durationMs % MS_PER_MINUTE) / MS_PER_SECOND);

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}
