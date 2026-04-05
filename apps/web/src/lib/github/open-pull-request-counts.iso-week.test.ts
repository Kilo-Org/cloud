import {
  getCurrentIsoWeekBoundsInTimeZone,
  isIsoTimestampWithinBounds,
} from '@/lib/github/open-pull-request-counts';

describe('getCurrentIsoWeekBoundsInTimeZone (ISO week, Europe/Amsterdam)', () => {
  it('treats Monday 00:00 local as the start of week (inclusive), and next Monday 00:00 local as end (exclusive)', () => {
    // Week of 2026-01-12 (Mon). In Europe/Amsterdam during Jan: UTC+1.
    const bounds = getCurrentIsoWeekBoundsInTimeZone({
      now: new Date('2026-01-15T13:00:00.000Z'),
      timeZone: 'Europe/Amsterdam',
    });

    // 2026-01-12 00:00 local -> 2026-01-11 23:00Z
    expect(bounds.weekStart.toISOString()).toBe('2026-01-11T23:00:00.000Z');
    // 2026-01-19 00:00 local -> 2026-01-18 23:00Z
    expect(bounds.weekEnd.toISOString()).toBe('2026-01-18T23:00:00.000Z');

    expect(isIsoTimestampWithinBounds('2026-01-11T22:59:59.999Z', bounds)).toBe(false);
    expect(isIsoTimestampWithinBounds('2026-01-11T23:00:00.000Z', bounds)).toBe(true);
    expect(isIsoTimestampWithinBounds('2026-01-18T22:59:59.999Z', bounds)).toBe(true);
    expect(isIsoTimestampWithinBounds('2026-01-18T23:00:00.000Z', bounds)).toBe(false);
  });
});
