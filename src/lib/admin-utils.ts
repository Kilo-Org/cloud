import { formatDistanceToNow } from 'date-fns';
import type { PaymentMethodStatus } from '@/types/admin';

/**
 * Converts microdollars to formatted currency string with exactly 2 decimal places
 */
export function formatMicrodollars(microdollars: number, fractionDigits: number = 2): string {
  const dollars = microdollars / 1_000_000;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(dollars);
}

/**
 * Formats a date to relative time (e.g., "2 days ago")
 */
export function formatRelativeTime(date: Date | string): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  return formatDistanceToNow(dateObj, { addSuffix: true });
}

/**
 * Formats a date to a readable string
 */
export function formatDate(date: Date | string): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(dateObj);
}

export function getPaymentMethodBadgeVariant(
  status?: PaymentMethodStatus
): 'default' | 'secondary' | 'outline' {
  switch (status) {
    case 'eligible for hold':
      return 'default';
    case 'has hold':
      return 'default';
    case 'prev. eligible':
      return 'secondary';
    default:
      return 'outline';
  }
}

export function getPaymentMethodStatusDescription(status?: PaymentMethodStatus) {
  switch (status) {
    case 'stytch welcome credits':
      return 'User has received all free welcome credits from Stytch approval';
    case 'eligible for hold':
      return 'User has a payment method eligible for free tier credits, but has no hold yet';
    case 'has hold':
      return 'User has a novel payment method with a successful hold';
    case 'prev. eligible':
      return 'User previously had a free-tier eligible payment method but removed it';
    case 'all deleted':
      return 'User had payment methods but all have been removed; none were free-tier eligible';
    case 'has ineligible':
      return 'User has active payment methods, but none eligible for free credits (that requires a not-seen-before payment method and successful hold)';
    case 'none':
      return 'User has no payment methods on file';
    default:
      return null;
  }
}
