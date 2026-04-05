import { useMemo } from 'react';
import type { TimePeriod } from '@/lib/organizations/organization-types';

type DateRange = {
  startDate: string;
  endDate: string;
};

/**
 * Converts a TimePeriod enum value into actual start and end dates.
 *
 * This hook calculates the date range based on the selected time period,
 * using the current time as the end date and calculating the start date
 * by subtracting the appropriate duration.
 *
 * @param timePeriod - The time period to convert ('week', 'month', 'year', or 'all')
 * @returns ISO string dates for start and end of the period
 */
export function useDateRangeFromPeriod(timePeriod: TimePeriod): DateRange {
  return useMemo(() => {
    const now = new Date();
    let start: Date;

    switch (timePeriod) {
      case 'week':
        start = new Date(now);
        start.setDate(start.getDate() - 7);
        break;
      case 'month':
        start = new Date(now);
        start.setMonth(start.getMonth() - 1);
        break;
      case 'year':
        start = new Date(now);
        start.setFullYear(start.getFullYear() - 1);
        break;
      case 'all':
        // For 'all', we use a very old start date to include all historical data
        start = new Date('2020-01-01');
        break;
      default:
        start = new Date(now);
        start.setDate(start.getDate() - 7);
    }

    return {
      startDate: start.toISOString(),
      endDate: now.toISOString(),
    };
  }, [timePeriod]);
}
