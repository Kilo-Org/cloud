import { describe, expect, it } from 'vitest';

import { calendarDayIndex, calendarDaysBetween } from './device-calendar-day';

describe('calendarDayIndex', () => {
  it('counts calendar dates, not elapsed hours', () => {
    // 47 h 52 m apart, but two calendar dates apart: a rolling window says one.
    expect(
      calendarDaysBetween(
        new Date('2026-11-08T21:00:00.000Z'),
        new Date('2026-11-10T20:52:00.000Z'),
        'UTC'
      )
    ).toBe(2);
    // 30 minutes apart across local midnight: one date apart.
    expect(
      calendarDaysBetween(
        new Date('2026-11-09T23:40:00.000Z'),
        new Date('2026-11-10T00:10:00.000Z'),
        'UTC'
      )
    ).toBe(1);
  });

  it('reads the same instant as different dates in two zones', () => {
    // Sunday 21:00 UTC is Monday 11:00 in Kiritimati (UTC+14).
    const instant = new Date('2026-11-08T21:00:00.000Z');
    expect(calendarDayIndex(instant, 'Pacific/Kiritimati') - calendarDayIndex(instant, 'UTC')).toBe(
      1
    );
  });

  it('counts a day that gains or loses an hour as one day', () => {
    // 2027-03-14 in New York is 23 hours long; its two midnights are one day apart.
    expect(
      calendarDaysBetween(
        new Date('2027-03-14T05:00:00.000Z'),
        new Date('2027-03-15T04:00:00.000Z'),
        'America/New_York'
      )
    ).toBe(1);
  });

  it('reports no day for an invalid date instead of throwing', () => {
    expect(Number.isNaN(calendarDayIndex(new Date('not a date'), 'UTC'))).toBe(true);
  });

  it('is negative when the later date comes first', () => {
    expect(
      calendarDaysBetween(
        new Date('2026-11-10T08:00:00.000Z'),
        new Date('2026-11-08T09:00:00.000Z'),
        'UTC'
      )
    ).toBe(-2);
  });
});
