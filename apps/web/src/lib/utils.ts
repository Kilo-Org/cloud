import type { PaymentMethodInfo } from './stripePaymentMethodInfo';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ZodType } from 'zod';

export { formatCents, formatDollars } from '@kilocode/app-shared/utils';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function getInitialsFromName(name: string): string {
  if (!name) return '';

  return name
    .split(' ')
    .map(part => part.charAt(0).toUpperCase())
    .join('')
    .slice(0, 2);
}

export function formatDate(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleDateString();
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when `value` is a bare calendar-date string of the form "YYYY-MM-DD".
 *
 * Snowflake date-granularity buckets are serialized as date-only strings
 * representing a UTC calendar day. `new Date("YYYY-MM-DD")` parses them as
 * UTC midnight, so downstream `toLocaleDateString()` would shift the displayed
 * day into the viewer's local zone. Callers that render these buckets should
 * detect this shape and format with `timeZone: 'UTC'`.
 */
export function isDateOnlyString(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY_RE.test(value);
}

/**
 * Parses `value` and rejects both null input and an Invalid Date. This is the
 * shared parse-and-validate step for the nullable date formatters, so a missing
 * or malformed value renders the em-dash instead of "Invalid Date".
 */
function toValidDate(value: string | Date | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatIsoDateString_UsaDateOnlyFormat(dateString: string | Date | null): string {
  const date = toValidDate(dateString);
  if (!date) return '—';
  const formatOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  };
  if (isDateOnlyString(dateString)) {
    formatOptions.timeZone = 'UTC';
  }
  return date.toLocaleDateString('en-US', formatOptions);
}

/**
 * Formats a full ISO datetime string as a locale hour only, e.g. "10 AM".
 * Used for hourly usage buckets within a single day (Today / Yesterday).
 * Full ISO timestamps are interpreted in the viewer's local time zone — do
 * not pass date-only strings.
 */
export function formatIsoHourString_UsaHourFormat(dateString: string | Date | null): string {
  const date = toValidDate(dateString);
  if (!date) return '—';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
}

/**
 * Formats a full ISO datetime string as "MMM d, h a", e.g. "Apr 24, 10 AM".
 * Used when hourly usage buckets span multiple days (Past Week with hourly
 * granularity).
 */
export function formatIsoDateTime_UsaDateHourFormat(dateString: string | Date | null): string {
  const date = toValidDate(dateString);
  if (!date) return '—';
  const datePart = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const hourPart = date.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
  return `${datePart}, ${hourPart}`;
}

export function formatIsoDateTime_IsoOrderNoSeconds(dateString: string | Date | null): string {
  const date = toValidDate(dateString);
  if (!date) return '—';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function formatLargeNumber(num: number, shorten: boolean = false): string {
  if (num < 1000000) {
    return num.toLocaleString();
  }

  const units = [
    { value: 1e15, label: 'quadrillion', short: 'quadrillion' },
    { value: 1e12, label: 'trillion', short: 'T' },
    { value: 1e9, label: 'billion', short: 'B' },
    { value: 1e6, label: 'million', short: 'M' },
  ];

  for (const unit of units) {
    if (num >= unit.value) {
      const formatted = (num / unit.value).toFixed(1);
      return `${formatted} ${shorten ? unit.short : unit.label}`;
    }
  }

  return num.toLocaleString();
}

export function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return 'Not available';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  return `${scaled.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

export async function parseResultJsonWithZodSchema<T>(
  response: Response,
  schema: ZodType<T>
): Promise<T> {
  if (!response.ok) {
    let errorMessage = `Failed to fetch data: ${response.statusText}`;

    try {
      const errorData = await response.json();

      // Check for API error message
      if (
        errorData &&
        typeof errorData === 'object' &&
        'error' in errorData &&
        typeof errorData.error === 'string'
      ) {
        errorMessage = errorData.error;
      }
    } catch (_jsonError) {
      // Keep the default error message if JSON parsing fails
    }

    throw new Error(errorMessage);
  }

  const jsonData = await response.json();

  return schema.parse(jsonData);
}

/**
 * Converts the first character of a string to uppercase.
 * Note: This is NOT full title-casing (e.g., "hello world" → "Hello world", not "Hello World")
 */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Asserts that a value is not null or undefined and narrows its type.
 * Throws an error if the value is null or undefined.
 * This version provides type narrowing of the original parameter.
 *
 * @param value - The value to check for null/undefined
 * @param message - Optional custom error message
 * @throws Error if the value is null or undefined
 */
export function assertNotNullish<T>(value: T, message?: string): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(message || 'Value must not be null or undefined');
  }
}

/**
 * Asserts that a value is not null or undefined and returns it with proper type narrowing.
 * Throws an error if the value is null or undefined.
 * This version returns the non-null value for use in expressions.
 *
 * @param value - The value to check for null/undefined
 * @param message - Optional custom error message
 * @returns The value with null and undefined removed from its type
 * @throws Error if the value is null or undefined
 */
export function toNonNullish<T>(value: T, message?: string): NonNullable<T> {
  assertNotNullish(value, message);
  return value;
}

/**
 * Describes the payment method types the settings UI presents: "Stripe Link"
 * and card endings. Returns `''` for any other Stripe method type.
 */
export function formatPaymentMethodDescription(info: PaymentMethodInfo): string {
  if (info.type === 'link') {
    return 'Stripe Link';
  }
  if (info.type === 'card' && info.last4) {
    const brand = info.brand ? capitalize(info.brand) : 'Card';
    return `${brand} ending in ${info.last4}`;
  }
  return '';
}
