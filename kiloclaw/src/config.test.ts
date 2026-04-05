import { describe, it, expect } from 'vitest';
import { getProactiveRefreshThresholdMs, PROACTIVE_REFRESH_THRESHOLD_MS } from './config';

describe('getProactiveRefreshThresholdMs', () => {
  it('returns default when no override', () => {
    expect(getProactiveRefreshThresholdMs(undefined)).toBe(PROACTIVE_REFRESH_THRESHOLD_MS);
  });

  it('returns default for empty string', () => {
    expect(getProactiveRefreshThresholdMs('')).toBe(PROACTIVE_REFRESH_THRESHOLD_MS);
  });

  it('converts hours to milliseconds', () => {
    expect(getProactiveRefreshThresholdMs('24')).toBe(24 * 60 * 60 * 1000);
  });

  it('handles fractional hours', () => {
    expect(getProactiveRefreshThresholdMs('0.5')).toBe(30 * 60 * 1000);
  });

  it('returns default for non-numeric string', () => {
    expect(getProactiveRefreshThresholdMs('abc')).toBe(PROACTIVE_REFRESH_THRESHOLD_MS);
  });

  it('returns default for zero', () => {
    expect(getProactiveRefreshThresholdMs('0')).toBe(PROACTIVE_REFRESH_THRESHOLD_MS);
  });

  it('returns default for negative value', () => {
    expect(getProactiveRefreshThresholdMs('-5')).toBe(PROACTIVE_REFRESH_THRESHOLD_MS);
  });

  it('accepts large values for testing', () => {
    expect(getProactiveRefreshThresholdMs('8760')).toBe(365 * 24 * 60 * 60 * 1000);
  });
});
