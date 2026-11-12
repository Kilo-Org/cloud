import { describe, expect, test } from 'vitest';

import { fillDailySeries, usageRangeWindow } from './usage-window';

// 2026-11-12T15:30:00Z: a mid-day moment, so a window that forgot to snap to
// UTC midnight would show up as a different start.
const NOW = new Date('2026-11-12T15:30:00.000Z');

describe('usageRangeWindow', () => {
  test('7 days is today plus the six before it, from UTC midnight', () => {
    const window = usageRangeWindow('7d', NOW);
    expect(window.startDate).toBe('2026-11-06T00:00:00.000Z');
    expect(window.endDate).toBe(NOW.toISOString());
  });

  test('30 days starts on the same weekday 29 days back', () => {
    const window = usageRangeWindow('30d', NOW);
    expect(window.startDate).toBe('2026-10-14T00:00:00.000Z');
  });

  test('90 days spans a quarter of whole days', () => {
    const window = usageRangeWindow('90d', NOW);
    expect(window.startDate).toBe('2026-08-15T00:00:00.000Z');
    // The window covers 90 calendar days: 89 whole days back from today plus
    // today's partial one.
    const days =
      Math.floor(
        (new Date(window.endDate).getTime() - new Date(window.startDate).getTime()) /
          (24 * 60 * 60 * 1000)
      ) + 1;
    expect(days).toBe(90);
  });
});

describe('fillDailySeries', () => {
  const window = {
    startDate: '2026-11-06T00:00:00.000Z',
    endDate: '2026-11-12T15:30:00.000Z',
  };

  test('keeps one bucket per day of the window and zeros the quiet days', () => {
    const series = fillDailySeries(window, [
      { datetime: '2026-11-06', value: 3 },
      { datetime: '2026-11-12', value: 7 },
    ]);

    expect(series).toHaveLength(7);
    expect(series[0]).toEqual({ datetime: '2026-11-06', value: 3 });
    expect(series.at(-1)).toEqual({ datetime: '2026-11-12', value: 7 });
    expect(series.slice(1, -1).every(point => point.value === 0)).toBe(true);
  });

  test('adds buckets the warehouse never returned', () => {
    const series = fillDailySeries(window, [{ datetime: '2026-11-09', value: 2 }]);
    expect(series.map(point => point.datetime)).toEqual([
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
    ]);
    expect(series[3]?.value).toBe(2);
    expect(series.filter(point => point.value === 0)).toHaveLength(6);
  });
});
