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

/**
 * Whether two moments fall on the same UTC bucketing day, the granularity the
 * window is asked for.
 */
export function isSameUtcDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/**
 * The served series widened to the window: the warehouse returns a bucket only
 * for a day that held usage, so placing bars by array index would compress the
 * quiet days and read a 30-day range as a short contiguous run. Every whole UTC
 * day the window covers is present, with zero for a day that reported nothing.
 */
export function fillDailySeries(
  window: UsageWindow,
  points: readonly { datetime: string; value: number }[]
): { datetime: string; value: number }[] {
  const values = new Map<string, number>();
  for (const point of points) {
    const day = point.datetime.slice(0, 10);
    values.set(day, (values.get(day) ?? 0) + point.value);
  }

  const end = window.endDate.slice(0, 10);
  const series: { datetime: string; value: number }[] = [];
  const cursor = new Date(`${window.startDate.slice(0, 10)}T00:00:00.000Z`);
  for (;;) {
    const day = cursor.toISOString().slice(0, 10);
    series.push({ datetime: day, value: values.get(day) ?? 0 });
    if (day >= end) {
      return series;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}
