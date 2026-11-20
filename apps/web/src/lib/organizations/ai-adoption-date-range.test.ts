import { describe, test, expect } from '@jest/globals';
import { roundAIAdoptionDateRange } from './ai-adoption-date-range';

describe('roundAIAdoptionDateRange', () => {
  test('gives the same range for mounts within the same hour', () => {
    const first = roundAIAdoptionDateRange({
      startDate: '2026-10-21T10:05:03.123Z',
      endDate: '2026-11-20T10:05:03.123Z',
    });
    const later = roundAIAdoptionDateRange({
      startDate: '2026-10-21T10:48:59.999Z',
      endDate: '2026-11-20T10:48:59.999Z',
    });

    expect(later).toEqual(first);
    expect(first).toEqual({
      startDate: '2026-10-21T10:00:00.000Z',
      endDate: '2026-11-20T11:00:00.000Z',
    });
  });

  test('moves to a new range in the next hour', () => {
    const range = roundAIAdoptionDateRange({
      startDate: '2026-10-21T11:00:01.000Z',
      endDate: '2026-11-20T11:00:01.000Z',
    });

    expect(range.endDate).toBe('2026-11-20T12:00:00.000Z');
  });

  test('leaves hour-aligned values unchanged, so rounding twice is a no-op', () => {
    const aligned = {
      startDate: '2026-11-13T00:00:00.000Z',
      endDate: '2026-11-20T00:00:00.000Z',
    };

    expect(roundAIAdoptionDateRange(aligned)).toEqual(aligned);
  });
});
