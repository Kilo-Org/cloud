import { describe, expect, it } from 'vitest';

import { calendarDayLabel, calendarDaysBetween } from './calendar-day-label';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('calendarDaysBetween', () => {
  it('counts local dates, not elapsed hours', () => {
    // 47 h 52 m apart, but two local dates apart: the rolling window says one day.
    expect(calendarDaysBetween(new Date(2026, 10, 8, 21, 0), new Date(2026, 10, 10, 20, 52))).toBe(
      2
    );
    // 30 minutes apart across local midnight: one date apart.
    expect(calendarDaysBetween(new Date(2026, 10, 9, 23, 40), new Date(2026, 10, 10, 0, 10))).toBe(
      1
    );
  });

  it('is negative when the later date comes first', () => {
    expect(calendarDaysBetween(new Date(2026, 10, 10, 8, 0), new Date(2026, 10, 8, 9, 0))).toBe(-2);
    expect(calendarDaysBetween(new Date(2026, 10, 10, 8, 0), new Date(2026, 10, 10, 23, 0))).toBe(
      0
    );
  });
});

describe('calendarDayLabel', () => {
  // Local Tuesday 20:52.
  const now = new Date(2026, 10, 10, 20, 52).getTime();

  it('replaces a rolling "yesterday" that the calendar places two days back', () => {
    // 47 h 52 m old: `timeAgo` calls this "yesterday", the calendar calls it Sunday.
    expect(calendarDayLabel(new Date(2026, 10, 8, 21, 0), now, 'YESTERDAY')).toBe('2 DAYS AGO');
  });

  it('keeps the yesterday word when the calendar really places it there', () => {
    expect(calendarDayLabel(new Date(2026, 10, 9, 19, 52), now, 'YESTERDAY')).toBe('YESTERDAY');
  });

  it('leaves minute, hour, month, and year labels unchanged', () => {
    expect(calendarDayLabel(new Date(now - 3 * HOUR_MS), now, '3 HOURS AGO')).toBe('3 HOURS AGO');
    expect(calendarDayLabel(new Date(now - 45 * DAY_MS), now, 'LAST MONTH')).toBe('LAST MONTH');
    expect(calendarDayLabel(new Date(now - 400 * DAY_MS), now, 'LAST YEAR')).toBe('LAST YEAR');
  });

  it('formats a future date as days ahead', () => {
    expect(calendarDayLabel(new Date(2026, 10, 12, 9, 0), now, 'IN 2 DAYS')).toBe('IN 2 DAYS');
    expect(calendarDayLabel(new Date(2026, 10, 13, 9, 0), now, 'IN 3 DAYS')).toBe('IN 3 DAYS');
  });
});
