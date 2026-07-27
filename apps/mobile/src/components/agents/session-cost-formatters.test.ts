import { describe, expect, it } from 'vitest';

import { formatSpokenCost } from './session-row-accessibility-label';
import {
  composeStoredSessionSpokenMeta,
  formatSessionTotalCost,
  selectSessionCostInputs,
} from './session-list-helpers';

/**
 * Canonical session cost formatters (visible + spoken + selector).
 *
 * Microdollars is the count of $0.000001 units (USD × 1,000,000). Visible and
 * spoken agree on the omit band; the selector takes max(persisted, live).
 */
describe('formatSessionTotalCost (visible)', () => {
  it('returns null for null', () => {
    expect(formatSessionTotalCost(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(formatSessionTotalCost(undefined)).toBeNull();
  });

  it('returns null for zero, negative, and non-finite', () => {
    expect(formatSessionTotalCost(0)).toBeNull();
    expect(formatSessionTotalCost(-1)).toBeNull();
    expect(formatSessionTotalCost(Number.NaN)).toBeNull();
    expect(formatSessionTotalCost(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('omits 1..49 µ$ (would render a false $0.0000)', () => {
    expect(formatSessionTotalCost(1)).toBeNull();
    expect(formatSessionTotalCost(25)).toBeNull();
    expect(formatSessionTotalCost(49)).toBeNull();
  });

  it('formats sub-half-cent values to four decimals', () => {
    expect(formatSessionTotalCost(50)).toBe('$0.0001');
    expect(formatSessionTotalCost(3081)).toBe('$0.0031');
    expect(formatSessionTotalCost(4999)).toBe('$0.0050');
  });

  it('switches to two decimals at the half-cent threshold (inclusive)', () => {
    expect(formatSessionTotalCost(5000)).toBe('$0.01');
    expect(formatSessionTotalCost(9999)).toBe('$0.01');
    expect(formatSessionTotalCost(10_000)).toBe('$0.01');
    expect(formatSessionTotalCost(13_113)).toBe('$0.01');
  });

  it('formats multi-dollar values to two decimals', () => {
    expect(formatSessionTotalCost(1_234_567)).toBe('$1.23');
  });
});

describe('formatSpokenCost (a11y)', () => {
  it('returns null for null', () => {
    expect(formatSpokenCost(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(formatSpokenCost(undefined)).toBeNull();
  });

  it('returns null for zero', () => {
    expect(formatSpokenCost(0)).toBeNull();
  });

  it('returns null for negative values', () => {
    expect(formatSpokenCost(-1)).toBeNull();
  });

  it('returns null for non-finite numbers', () => {
    expect(formatSpokenCost(Number.NaN)).toBeNull();
    expect(formatSpokenCost(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatSpokenCost(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('returns null in the visible omit band (1..49 µ$)', () => {
    expect(formatSpokenCost(1)).toBeNull();
    expect(formatSpokenCost(25)).toBeNull();
    expect(formatSpokenCost(49)).toBeNull();
  });

  it('speaks sub-half-cent values as fractional cents', () => {
    expect(formatSpokenCost(50)).toBe('0.01 cents');
    expect(formatSpokenCost(3081)).toBe('0.31 cents');
    expect(formatSpokenCost(4000)).toBe('0.4 cents');
    expect(formatSpokenCost(4999)).toBe('0.5 cents');
  });

  it('rounds at the half-cent boundary (5000 micro → "1 cent")', () => {
    expect(formatSpokenCost(5000)).toBe('1 cent');
    expect(formatSpokenCost(13_113)).toBe('1 cent');
  });

  it('speaks a single sub-dollar cent in singular form', () => {
    expect(formatSpokenCost(10_000)).toBe('1 cent');
  });

  it('speaks sub-dollar values in plural form', () => {
    expect(formatSpokenCost(100_000)).toBe('10 cents');
    expect(formatSpokenCost(500_000)).toBe('50 cents');
    expect(formatSpokenCost(990_000)).toBe('99 cents');
  });

  it('speaks a whole-dollar amount in singular form with no cents phrase', () => {
    expect(formatSpokenCost(1_000_000)).toBe('1 dollar');
  });

  it('speaks a whole-dollar amount in plural form with no cents phrase', () => {
    expect(formatSpokenCost(5_000_000)).toBe('5 dollars');
  });

  it('speaks a dollar-and-cents amount with both phrases', () => {
    expect(formatSpokenCost(3_420_000)).toBe('3 dollars 42 cents');
  });

  it('speaks a singular-dollar + plural-cents amount', () => {
    expect(formatSpokenCost(1_100_000)).toBe('1 dollar 10 cents');
  });

  it('speaks a plural-dollar + singular-cent amount', () => {
    expect(formatSpokenCost(2_010_000)).toBe('2 dollars 1 cent');
  });
});

describe('selectSessionCostInputs', () => {
  it('returns null total when both inputs are absent', () => {
    expect(selectSessionCostInputs(null, 0)).toEqual({
      totalMicrodollars: null,
      breakdownCostUsd: 0,
    });
    expect(selectSessionCostInputs(undefined, 0)).toEqual({
      totalMicrodollars: null,
      breakdownCostUsd: 0,
    });
  });

  it('uses persisted when live is zero', () => {
    expect(selectSessionCostInputs(120_000, 0)).toEqual({
      totalMicrodollars: 120_000,
      breakdownCostUsd: 0,
    });
  });

  it('uses live µ$ when persisted is null', () => {
    expect(selectSessionCostInputs(null, 0.12)).toEqual({
      totalMicrodollars: 120_000,
      breakdownCostUsd: 0.12,
    });
  });

  it('picks the larger of persisted and live', () => {
    expect(selectSessionCostInputs(500_000, 0.1)).toEqual({
      totalMicrodollars: 500_000,
      breakdownCostUsd: 0.1,
    });
    expect(selectSessionCostInputs(100_000, 0.5)).toEqual({
      totalMicrodollars: 500_000,
      breakdownCostUsd: 0.5,
    });
  });

  it('returns the shared value when equal', () => {
    expect(selectSessionCostInputs(120_000, 0.12)).toEqual({
      totalMicrodollars: 120_000,
      breakdownCostUsd: 0.12,
    });
  });

  it('treats non-finite and negative inputs as zero', () => {
    expect(selectSessionCostInputs(Number.NaN, Number.NaN)).toEqual({
      totalMicrodollars: null,
      breakdownCostUsd: 0,
    });
    expect(selectSessionCostInputs(-100, -0.5)).toEqual({
      totalMicrodollars: null,
      breakdownCostUsd: 0,
    });
    expect(selectSessionCostInputs(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toEqual({
      totalMicrodollars: null,
      breakdownCostUsd: 0,
    });
  });

  it('never leaks the combined total into breakdownCostUsd (composition gate)', () => {
    // persisted $0.50 wins over live $0.001, but breakdown stays the live sum
    const result = selectSessionCostInputs(500_000, 0.001);
    expect(result.totalMicrodollars).toBe(500_000);
    expect(result.breakdownCostUsd).toBe(0.001);
  });
});

/**
 * End-to-end spoken meta composition — the exact wiring the row uses.
 * These tests would fail if the row composed spoken meta with the visible
 * formatter (`formatSessionTotalCost` → "$0.12") instead of the humanized
 * spoken formatter (`formatSpokenCost` → "12 cents").
 */
describe('composeStoredSessionSpokenMeta (spoken wiring)', () => {
  it('composes a humanized cost phrase with the spoken time', () => {
    const result = composeStoredSessionSpokenMeta(formatSpokenCost(120_000), '5 minutes ago');
    expect(result).toBe('cost 12 cents, 5 minutes ago');
  });

  it('composes a fractional-cent cost with the spoken time', () => {
    const result = composeStoredSessionSpokenMeta(formatSpokenCost(4000), '2 hours ago');
    expect(result).toBe('cost 0.4 cents, 2 hours ago');
  });

  it('omits the cost phrase when cost is null (time-only)', () => {
    const result = composeStoredSessionSpokenMeta(formatSpokenCost(null), '3 days ago');
    expect(result).toBe('3 days ago');
  });

  it('produces a humanized form with no "$" character', () => {
    const result = composeStoredSessionSpokenMeta(formatSpokenCost(3_420_000), '1 hour ago');
    expect(result).toBe('cost 3 dollars 42 cents, 1 hour ago');
    expect(result).not.toContain('$');
  });
});
