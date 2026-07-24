import { describe, expect, it } from 'vitest';

import { formatSpokenCost } from './session-row-accessibility-label';
import { composeStoredSessionSpokenMeta, formatSessionListCost } from './session-list-helpers';

/**
 * F1 — list cost (visible + spoken formatters).
 *
 * Microdollars is the count of $0.000001 units (USD × 1,000,000). Both
 * helpers collapse null/0/non-finite inputs to `null` so the row can omit
 * the cost segment entirely. Visible and spoken forms are kept independent
 * because the visible row wants compact "$0.12" while VoiceOver wants
 * words ("12 cents").
 */
describe('formatSessionListCost (visible)', () => {
  it('returns null for null', () => {
    expect(formatSessionListCost(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(formatSessionListCost(undefined)).toBeNull();
  });

  it('returns null for zero', () => {
    expect(formatSessionListCost(0)).toBeNull();
  });

  it('returns null for negative values', () => {
    expect(formatSessionListCost(-1)).toBeNull();
  });

  it('returns null for non-finite numbers', () => {
    expect(formatSessionListCost(Number.NaN)).toBeNull();
    expect(formatSessionListCost(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatSessionListCost(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('renders sub-half-cent values as "<$0.01" (not "$0.00")', () => {
    // microdollars < 5000 → usd < 0.005
    expect(formatSessionListCost(1)).toBe('<$0.01');
    expect(formatSessionListCost(4999)).toBe('<$0.01');
  });

  it('rounds at the half-cent boundary (5000 micro → "$0.01", not "<$0.01")', () => {
    // usd = 0.005 → toFixed(2) = "0.01"
    expect(formatSessionListCost(5000)).toBe('$0.01');
  });

  it('formats a typical sub-dollar value to two decimal places', () => {
    expect(formatSessionListCost(120_000)).toBe('$0.12');
  });

  it('formats whole-dollar values', () => {
    expect(formatSessionListCost(1_000_000)).toBe('$1.00');
    expect(formatSessionListCost(12_500_000)).toBe('$12.50');
  });

  it('formats a multi-dollar value with cents', () => {
    expect(formatSessionListCost(3_420_000)).toBe('$3.42');
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

  it('returns null when the value rounds to zero cents', () => {
    expect(formatSpokenCost(4000)).toBeNull();
    expect(formatSpokenCost(4999)).toBeNull();
  });

  it('rounds at the half-cent boundary (5000 micro → "1 cent")', () => {
    expect(formatSpokenCost(5000)).toBe('1 cent');
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

/**
 * End-to-end spoken meta composition — the exact wiring the row uses.
 * These tests would fail if the row composed spoken meta with the visible
 * formatter (`formatSessionListCost` → "$0.12") instead of the humanized
 * spoken formatter (`formatSpokenCost` → "12 cents").
 */
describe('composeStoredSessionSpokenMeta (spoken wiring)', () => {
  it('composes a humanized cost phrase with the spoken time', () => {
    const result = composeStoredSessionSpokenMeta(formatSpokenCost(120_000), '5 minutes ago');
    expect(result).toBe('cost 12 cents, 5 minutes ago');
  });

  it('omits the cost phrase for a sub-half-cent charge (time-only)', () => {
    const result = composeStoredSessionSpokenMeta(formatSpokenCost(4000), '2 hours ago');
    expect(result).toBe('2 hours ago');
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
