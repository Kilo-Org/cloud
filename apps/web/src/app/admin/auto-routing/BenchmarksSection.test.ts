import { describe, expect, it } from '@jest/globals';
import { formatAccuracy, formatUsd } from './BenchmarksSection';

describe('formatAccuracy', () => {
  it('formats 0.8542 as 85.4%', () => {
    expect(formatAccuracy(0.8542)).toBe('85.4%');
  });

  it('formats 1.0 as 100.0%', () => {
    expect(formatAccuracy(1.0)).toBe('100.0%');
  });

  it('formats 0 as 0.0%', () => {
    expect(formatAccuracy(0)).toBe('0.0%');
  });

  it('formats 0.5 as 50.0%', () => {
    expect(formatAccuracy(0.5)).toBe('50.0%');
  });

  it('rounds to one decimal place', () => {
    expect(formatAccuracy(0.9999)).toBe('100.0%');
    expect(formatAccuracy(0.9994)).toBe('99.9%');
  });
});

describe('formatUsd', () => {
  it('returns em dash for null', () => {
    expect(formatUsd(null)).toBe('—');
  });

  it('formats a small cost with 6 decimal places', () => {
    expect(formatUsd(0.000123)).toBe('$0.000123');
  });

  it('trims trailing zeros', () => {
    expect(formatUsd(0.1)).toBe('$0.1');
  });

  it('formats zero as $0.0', () => {
    expect(formatUsd(0)).toBe('$0.0');
  });

  it('formats a typical cost', () => {
    expect(formatUsd(0.001234)).toBe('$0.001234');
  });

  it('formats a cost that fits exactly at 6dp', () => {
    expect(formatUsd(0.000001)).toBe('$0.000001');
  });
});
