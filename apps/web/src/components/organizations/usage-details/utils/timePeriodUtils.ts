import type { TimePeriod } from '@/lib/organizations/organization-types';

/**
 * Converts a TimePeriod enum value to a human-readable label.
 *
 * @param period - The time period enum value
 * @returns Human-readable label for the time period
 */
export function getTimePeriodLabel(period: TimePeriod): string {
  switch (period) {
    case 'week':
      return 'Past Week';
    case 'month':
      return 'Past Month';
    case 'year':
      return 'Past Year';
    case 'all':
      return 'All Time';
    default:
      return 'Past Week';
  }
}
