export const ISO_CURRENCY_PATTERN = /^[a-z]{3}$/;

const SERVICE_FEE_FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

/** Trimmed text, or null when the value is not a string or trims to nothing. */
export function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isServiceFeeFailureCode(value: string): boolean {
  return SERVICE_FEE_FAILURE_CODE_PATTERN.test(value);
}

export function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

/** UTC ISO-8601 for a `Date` or a database timestamptz string. */
export function toIsoTimestamp(value: Date | string, label = 'service fee'): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} timestamp is invalid`);
  }
  return date.toISOString();
}
