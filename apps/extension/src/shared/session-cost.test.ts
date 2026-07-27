import { describe, expect, it } from 'vitest';
import { addSessionCost, formatSessionCost } from './session-cost';

describe('session cost helpers', () => {
  it('formats zero and non-positive values as $0.0000', () => {
    expect(formatSessionCost(0)).toBe('$0.0000');
    expect(formatSessionCost(-0.01)).toBe('$0.0000');
    expect(formatSessionCost(Number.NaN)).toBe('$0.0000');
    expect(formatSessionCost(Number.POSITIVE_INFINITY)).toBe('$0.0000');
  });

  it('formats positive costs to four decimal places', () => {
    expect(formatSessionCost(0.0123)).toBe('$0.0123');
    expect(formatSessionCost(1.234)).toBe('$1.2340');
    expect(formatSessionCost(5e-5)).toBe('$0.0001');
  });

  it('adds finite non-negative costs', () => {
    expect(addSessionCost(0.0123, 0.0007)).toBeCloseTo(0.013);
    expect(addSessionCost(0.013, 0.001)).toBeCloseTo(0.014);
    expect(addSessionCost(0, 0)).toBe(0);
  });

  it('leaves the previous total unchanged for missing, non-finite, or negative cost', () => {
    const usageWithoutCost: { costUsd?: number } = {};
    expect(addSessionCost(0.5, usageWithoutCost.costUsd)).toBe(0.5);
    expect(addSessionCost(0.5, Number.NaN)).toBe(0.5);
    expect(addSessionCost(0.5, Number.POSITIVE_INFINITY)).toBe(0.5);
    expect(addSessionCost(0.5, -0.01)).toBe(0.5);
  });
});
