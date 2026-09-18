import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MULTIPLIER,
  DEFAULT_WINDOW_HOURS,
  DISABLED_MULTIPLIER,
  DISABLED_THRESHOLD_USD,
  multiplierBasisPoints,
  multiplierError,
  parseMultiplier,
  parseThreshold,
  thresholdError,
  toWindowHours,
} from '@/components/organization/spend-alert-validators';

// `pnpm check:i18n` owns the copy; these assert the bounds, not the wording.
const THRESHOLD_CASES: [string, number | null][] = [
  ['', null],
  ['   ', null],
  ['0', null],
  ['-5', null],
  ['not a number', null],
  ['25', 25],
  ['25.50', 25.5],
  ['1,000', 1000],
  ['1000000', 1_000_000],
  ['1000000.01', null],
  // Below one microdollar the wire's `round(usd * 1_000_000)` stores a zero
  // threshold, which fires on any spend and never clears.
  ['0.000001', 0.000_001],
  ['0.0000001', null],
];

const MULTIPLIER_CASES: [string, number | null][] = [
  ['', null],
  ['0.9', null],
  ['0', null],
  ['-2', null],
  ['not a number', null],
  ['1', 1],
  ['2.5', 2.5],
  ['50', 50],
  ['50.01', null],
];

describe('parseThreshold', () => {
  it.each(THRESHOLD_CASES)('parses %s to %s', (value, expected) => {
    expect(parseThreshold(value)).toBe(expected);
  });

  it('reports an inline error only while the limit is out of range', () => {
    expect(thresholdError('25')).toBeNull();
    expect(thresholdError('0')).not.toBeNull();
    expect(thresholdError('1000000.01')).not.toBeNull();
  });
});

describe('parseMultiplier', () => {
  it.each(MULTIPLIER_CASES)('parses %s to %s', (value, expected) => {
    expect(parseMultiplier(value)).toBe(expected);
  });

  it('reports an inline error only while the multiplier is below 1x or above the cap', () => {
    expect(multiplierError('2')).toBeNull();
    expect(multiplierError('0.5')).not.toBeNull();
    expect(multiplierError('51')).not.toBeNull();
  });
});

describe('disabled-kind stand-ins', () => {
  it('are the smallest values the wire accepts', () => {
    // A switched-off kind submits these instead of gating Save on a field the
    // owner deliberately left empty.
    expect(parseThreshold(String(DISABLED_THRESHOLD_USD))).toBe(DISABLED_THRESHOLD_USD);
    expect(parseMultiplier(String(DISABLED_MULTIPLIER))).toBe(DISABLED_MULTIPLIER);
    expect(multiplierBasisPoints(DISABLED_MULTIPLIER)).toBe(100);
  });
});

describe('multiplierBasisPoints', () => {
  it('converts a multiplier to the wire basis points', () => {
    expect(multiplierBasisPoints(1)).toBe(100);
    expect(multiplierBasisPoints(DEFAULT_MULTIPLIER)).toBe(200);
    expect(multiplierBasisPoints(1.5)).toBe(150);
  });
});

describe('toWindowHours', () => {
  it('defaults an unsaved or unknown window to the 24-hour default', () => {
    expect(DEFAULT_WINDOW_HOURS).toBe(24);
    expect(toWindowHours(null)).toBe(24);
    expect(toWindowHours(undefined)).toBe(24);
    expect(toWindowHours(999)).toBe(24);
  });

  it('keeps the windows the wire accepts', () => {
    expect(toWindowHours(24)).toBe(24);
    expect(toWindowHours(168)).toBe(168);
    expect(toWindowHours(720)).toBe(720);
  });
});
