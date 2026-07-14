/**
 * Parse a backend date or timestamp string into a Date.
 *
 * Hermes (React Native) cannot reliably parse PostgreSQL timestamps
 * ("2026-03-16 15:21:40.957+00") or date-only strings ("2026-09-26") with
 * `new Date()`, so all shared code must go through this helper.
 */
export function parseTimestamp(value: string): Date {
  // Date-only: "2026-09-26" → treat as UTC midnight
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00Z`);
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

/**
 * Canonical app-wide date format (e.g. "7/11/2026" for en-US).
 *
 * Follows the runtime's default locale (device locale on mobile, browser
 * locale on web) rather than a pinned locale, so it reads naturally for
 * every user. Pass a `Date`, not a raw backend string — parse backend
 * timestamps with `parseTimestamp()` first.
 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString();
}
