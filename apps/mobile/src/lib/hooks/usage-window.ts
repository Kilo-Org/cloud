// The date window behind the usage screen's 7/30/90 day picker. Pure on
// purpose: the screen's hook imports the app runtime, while the window rule is
// arithmetic and is tested on its own.

export type UsageRange = '7d' | '30d' | '90d';

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 } satisfies Record<UsageRange, number>;

/** A half-open window of UTC-day-aligned boundaries, as ISO strings. */
export type UsageWindow = { startDate: string; endDate: string };

/**
 * The window a range stands for: whole UTC days up to today, which is the day
 * bucketing the server uses. The last day stays partial, so a spend made a
 * minute ago is on the chart.
 */
export function usageRangeWindow(range: UsageRange, now: Date = new Date()): UsageWindow {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - (RANGE_DAYS[range] - 1));
  start.setUTCHours(0, 0, 0, 0);
  return { startDate: start.toISOString(), endDate: now.toISOString() };
}
