import { describe, expect, test } from 'vitest';

import { usageRangeWindow } from './usage-window';

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
