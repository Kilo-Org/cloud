import { describe, expect, it } from 'vitest';

import { calendarDayRelativeLabel } from './calendar-day-label';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('calendarDayRelativeLabel', () => {
  // Tuesday 20:52 in the zone under test, so the assertions never depend on the
  // host's own zone.
  const now = new Date('2026-11-10T20:52:00.000Z').getTime();
  const zone = 'UTC';

  it('replaces a rolling "yesterday" that the calendar places two days back', () => {
    // 47 h 52 m before the clock: the elapsed-time label is "yesterday".
    expect(
      calendarDayRelativeLabel(new Date('2026-11-08T21:00:00.000Z').toISOString(), {
        nowMs: now,
        timeZone: zone,
      })
    ).toBe('2 days ago');
  });

  it('keeps the yesterday word when the calendar really places it there', () => {
    expect(
      calendarDayRelativeLabel(new Date('2026-11-09T19:52:00.000Z').toISOString(), {
        nowMs: now,
        timeZone: zone,
      })
    ).toBe('yesterday');
  });

  it('leaves minute, hour, month, and year labels unchanged', () => {
    expect(
      calendarDayRelativeLabel(new Date(now - 3 * HOUR_MS).toISOString(), {
        nowMs: now,
        timeZone: zone,
      })
    ).toBe('3 hours ago');
    expect(
      calendarDayRelativeLabel(new Date(now - 45 * DAY_MS).toISOString(), {
        nowMs: now,
        timeZone: zone,
      })
    ).toBe('last month');
    expect(
      calendarDayRelativeLabel(new Date(now - 400 * DAY_MS).toISOString(), {
        nowMs: now,
        timeZone: zone,
      })
    ).toBe('last year');
  });

  it('formats a future date as days ahead', () => {
    expect(
      calendarDayRelativeLabel(new Date('2026-11-12T09:00:00.000Z').toISOString(), {
        nowMs: now,
        timeZone: zone,
      })
    ).toBe('in 2 days');
    expect(
      calendarDayRelativeLabel(new Date('2026-11-13T09:00:00.000Z').toISOString(), {
        nowMs: now,
        timeZone: zone,
      })
    ).toBe('in 3 days');
  });

  it('names the date the given zone shows', () => {
    // Sunday 21:00 UTC is Monday 11:00 in Kiritimati (UTC+14), and 09:00 UTC on
    // Tuesday is already Tuesday 23:00 there: the same 36-hour-old row is the
    // previous local date in Kiritimati and two local dates back in UTC.
    const iso = new Date('2026-11-08T21:00:00.000Z').toISOString();
    const nowMs = new Date('2026-11-10T09:00:00.000Z').getTime();
    expect(calendarDayRelativeLabel(iso, { nowMs, timeZone: 'Pacific/Kiritimati' })).toBe(
      'yesterday'
    );
    expect(calendarDayRelativeLabel(iso, { nowMs, timeZone: 'UTC' })).toBe('2 days ago');
  });

  it('omits an unparseable timestamp', () => {
    expect(calendarDayRelativeLabel('not-a-timestamp', { nowMs: now, timeZone: zone })).toBe('');
    expect(calendarDayRelativeLabel(null, { nowMs: now, timeZone: zone })).toBe('');
  });
});
