import { dateTimeFormat } from '@/lib/intl-cache';

const DAY_MS = 24 * 60 * 60 * 1000;

const DAY_PART_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
};

/**
 * The calendar date of `date` in `timeZone`, as a whole number of days from the
 * epoch, so two dates on the same local day compare equal and one local day
 * apart differs by exactly one. Built from the formatted year, month and day, so
 * a day that lost or gained an hour still counts as one day. `NaN` when the date
 * or the formatter cannot answer, which keeps one unreadable row from throwing
 * inside a list.
 */
export function calendarDayIndex(date: Date, timeZone: string): number {
  if (Number.isNaN(date.getTime())) {
    return Number.NaN;
  }
  const parts = dateTimeFormat('en-US', { ...DAY_PART_OPTIONS, timeZone }).formatToParts(date);
  const year = Number(parts.find(part => part.type === 'year')?.value);
  const month = Number(parts.find(part => part.type === 'month')?.value);
  const day = Number(parts.find(part => part.type === 'day')?.value);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return Number.NaN;
  }
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

/**
 * Whole calendar days from `from`'s local date to `to`'s local date in
 * `timeZone`, positive when `to` is later, `NaN` when either date is unreadable.
 */
export function calendarDaysBetween(from: Date, to: Date, timeZone: string): number {
  return calendarDayIndex(to, timeZone) - calendarDayIndex(from, timeZone);
}
