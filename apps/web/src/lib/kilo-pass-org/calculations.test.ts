import {
  bridgeRatio,
  isWindowCoveredByPaidThrough,
  monthlyWindowContaining,
  monthlyWindowFromOriginalAnchor,
  roundHalfUpMicrodollars,
  validateAllocation,
} from './calculations';

describe('Kilo Pass organization calculations', () => {
  it('derives parent default capacity and rejects invalid allocations', () => {
    expect(validateAllocation(10, [2, 3])).toEqual({
      valid: true,
      directChildCapacity: 5,
      parentDefaultCapacity: 5,
    });
    expect(validateAllocation(4, [2, 3])).toEqual({ valid: false, reason: 'overallocated' });
    expect(validateAllocation(4, [2, -1])).toEqual({ valid: false, reason: 'negative_capacity' });
  });

  it('uses the original anchor rather than cascading short-month clamping', () => {
    const anchor = new Date('2026-01-31T12:00:00.000Z');
    expect(monthlyWindowFromOriginalAnchor(anchor, 1).start.toISOString()).toBe(
      '2026-02-28T12:00:00.000Z'
    );
    expect(monthlyWindowFromOriginalAnchor(anchor, 2).start.toISOString()).toBe(
      '2026-03-31T12:00:00.000Z'
    );
  });

  it('finds the anchored monthly window containing a date', () => {
    const anchor = new Date('2026-01-31T12:00:00.000Z');
    expect(monthlyWindowContaining(anchor, new Date('2026-03-01T00:00:00.000Z'))).toEqual({
      start: new Date('2026-02-28T12:00:00.000Z'),
      end: new Date('2026-03-31T12:00:00.000Z'),
    });
  });

  it('requires complete paid-through coverage for a full window', () => {
    const window = monthlyWindowFromOriginalAnchor(new Date('2026-01-15T00:00:00.000Z'), 1);
    expect(
      isWindowCoveredByPaidThrough(window, {
        start: new Date('2026-02-15T00:00:00.000Z'),
        end: new Date('2026-03-15T00:00:00.000Z'),
      })
    ).toBe(true);
    expect(
      isWindowCoveredByPaidThrough(window, {
        start: new Date('2026-02-15T00:00:00.000Z'),
        end: new Date('2026-03-14T23:59:59.999Z'),
      })
    ).toBe(false);
  });

  it('calculates bridge ratio from the overlap and rounds half up', () => {
    const window = {
      start: new Date('2026-02-01T00:00:00.000Z'),
      end: new Date('2026-02-11T00:00:00.000Z'),
    };
    expect(
      bridgeRatio(window, {
        start: new Date('2026-02-06T00:00:00.000Z'),
        end: new Date('2026-02-11T00:00:00.000Z'),
      })
    ).toEqual({ numerator: 432_000_000, denominator: 864_000_000 });
    expect(roundHalfUpMicrodollars(5, 1, 2)).toBe(3);
    expect(roundHalfUpMicrodollars(4, 1, 2)).toBe(2);
  });
});
