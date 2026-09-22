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
