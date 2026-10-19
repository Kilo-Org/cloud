/**
 * Parse a backend date or timestamp string into a Date.
 *
 * Hermes (React Native) cannot reliably parse PostgreSQL timestamps
 * ("2026-03-16 15:21:40.957+00") or date-only strings ("2026-09-26") with
 * `new Date()`, so all shared code must go through this helper.
 *
 * A date-only string is a calendar date, not an instant: it becomes local
 * midnight, so formatting the result in the device timezone renders that same
 * day in every timezone. A surface that must render a date-only value in UTC
 * formats the calendar components directly (mobile: `formatCalendarDate`).
 */
export function parseTimestamp(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    // The multi-argument constructor maps years 0-99 to 1900-1999, so set the
    // full year explicitly to keep the backend's four-digit year.
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(0, 0, 0, 0);
    // The Date constructor rolls a non-existent day into the next month. Keep
    // such input unusable, as the ISO parse did, so callers that check for an
    // invalid Date still take their fallback.
    if (date.getMonth() !== month - 1 || date.getDate() !== day) {
      return new Date(Number.NaN);
    }
    return date;
  }
  // PostgreSQL: "2026-03-16 15:21:40.957+00" → need "T" separator and full tz offset "+00:00"
  const iso = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  return new Date(iso);
}

/** Returns the first non-empty string, or '' when none is set. */
export function firstNonEmpty(...values: (string | null | undefined)[]): string {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return '';
}

export function fromMicrodollars(microdollars: number): number {
  return microdollars / 1000000;
}

export function formatDollars(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatCents(amount: number, currency: string = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}
