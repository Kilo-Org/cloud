/**
 * Parse a timestamp that crossed the database boundary.
 *
 * Postgres `timestamptz` text is `"YYYY-MM-DD HH:MM:SS.sss+00"`, which is not
 * ISO-8601. Drivers and tests also surface compact offsets (`+0000`) and
 * hour-only offsets (`+05`). Normalize those shapes, reject values without an
 * explicit offset (otherwise `new Date` reads them as local time), and return
 * `null` for anything invalid.
 */
export function parseDbTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = value
    .replace(' ', 'T')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
    .replace(/([+-]\d{2})$/, '$1:00');
  if (!/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(normalized)) return null;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}
