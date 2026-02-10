import type { User } from '@/db/schema';
import type { PaymentMethodInfo } from './stripePaymentMethodInfo';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ZodType } from 'zod';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Checks if a string starts with a required prefix and removes it.
 * @param str The input string to check
 * @param prefix The required prefix to check for and remove
 * @returns The string with the prefix removed if it starts with the prefix, otherwise null
 */
export function stripRequiredPrefix(str: string, prefix: string): string | null {
  if (str.startsWith(prefix)) {
    return str.slice(prefix.length);
  }
  return null;
}

const parseFloatOrNull = (value: string | null) => (value === null ? null : parseFloat(value));
export const EmptyFraudDetectionHeaders = getFraudDetectionHeaders(new Headers());
export type FraudDetectionHeaders = ReturnType<typeof getFraudDetectionHeaders>;
export function getFraudDetectionHeaders(headers: Headers) {
  return {
    http_x_forwarded_for: headers.get('x-forwarded-for'),
    http_x_vercel_ip_city: headers.get('x-vercel-ip-city'),
    http_x_vercel_ip_country: headers.get('x-vercel-ip-country'),
    http_x_vercel_ip_latitude: parseFloatOrNull(headers.get('x-vercel-ip-latitude')),
    http_x_vercel_ip_longitude: parseFloatOrNull(headers.get('x-vercel-ip-longitude')),
    http_x_vercel_ja4_digest: headers.get('x-vercel-ja4-digest'),
    http_user_agent: headers.get('user-agent'),
    machine_id: headers.get('x-kilocode-machineid'),
  };
}

export function getInitials(user: User) {
  if (!user) {
    return '';
  }

  return getInitialsFromName(user.google_user_name || user.google_user_email || '');
}

export function getInitialsFromName(name: string): string {
  if (!name) return '';

  return name
    .split(' ')
    .map(part => part.charAt(0).toUpperCase())
    .join('')
    .slice(0, 2);
}

export function formatCents(amount: number, currency: string = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

export function formatDollars(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatDate(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleDateString();
}

export function formatIsoDateString_UsaDateOnlyFormat(dateString: string | Date | null): string {
  if (!dateString) return '—';
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatIsoDateTime_IsoOrderNoSeconds(dateString: string | Date | null): string {
  if (!dateString) return '—';
  const date = new Date(dateString);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function toMicrodollars(amount: number): number {
  return Math.round(amount * 1000000);
}

export function fromMicrodollars(microdollars: number): number {
  return microdollars / 1000000;
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
      //console.log('Failed to parse error response as JSON:', jsonError);
      // Keep the default error message if JSON parsing fails
    }

    throw new Error(errorMessage);
  }

  const jsonData = await response.json();

  return schema.parse(jsonData);
}

export function getLowerDomainFromEmail(email: string): string | null {
  return email?.split('@').pop()?.toLowerCase() || null;
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

export function formatPaymentMethodDescription(info: PaymentMethodInfo): string {
  if (info.type === 'link') {
    return 'Stripe Link';
  }
  if (info.type === 'card' && info.last4) {
    const brand = info.brand ? info.brand.charAt(0).toUpperCase() + info.brand.slice(1) : 'Card';
    return `${brand} ending in ${info.last4}`;
  }
  return '';
}
