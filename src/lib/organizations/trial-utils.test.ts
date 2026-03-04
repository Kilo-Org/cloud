import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { getOrgTrialStatusFromDays, getDaysRemainingInTrial } from './trial-utils';

describe('getOrgTrialStatusFromDays', () => {
  it('returns trial_active for 8+ days remaining', () => {
    expect(getOrgTrialStatusFromDays(14)).toBe('trial_active');
    expect(getOrgTrialStatusFromDays(8)).toBe('trial_active');
  });

  it('returns trial_ending_soon for 4-7 days remaining', () => {
    expect(getOrgTrialStatusFromDays(7)).toBe('trial_ending_soon');
    expect(getOrgTrialStatusFromDays(6)).toBe('trial_ending_soon');
    expect(getOrgTrialStatusFromDays(4)).toBe('trial_ending_soon');
  });

  it('returns trial_ending_very_soon for 1-3 days remaining', () => {
    expect(getOrgTrialStatusFromDays(3)).toBe('trial_ending_very_soon');
    expect(getOrgTrialStatusFromDays(2)).toBe('trial_ending_very_soon');
    expect(getOrgTrialStatusFromDays(1)).toBe('trial_ending_very_soon');
  });

  it('returns trial_expires_today for 0 days remaining', () => {
    expect(getOrgTrialStatusFromDays(0)).toBe('trial_expires_today');
  });

  it('returns trial_expired_soft for -1 to -3 days (1-3 days expired)', () => {
    expect(getOrgTrialStatusFromDays(-1)).toBe('trial_expired_soft');
    expect(getOrgTrialStatusFromDays(-2)).toBe('trial_expired_soft');
    expect(getOrgTrialStatusFromDays(-3)).toBe('trial_expired_soft');
  });

  it('returns trial_expired_hard for -4 or fewer days (4+ days expired)', () => {
    expect(getOrgTrialStatusFromDays(-4)).toBe('trial_expired_hard');
    expect(getOrgTrialStatusFromDays(-5)).toBe('trial_expired_hard');
    expect(getOrgTrialStatusFromDays(-10)).toBe('trial_expired_hard');
  });
});

describe('getDaysRemainingInTrial', () => {
  // Use fixed dates to avoid flakiness from timing differences
  const FIXED_NOW = '2024-01-15T12:00:00.000Z';
  const FIXED_NOW_MS = new Date(FIXED_NOW).getTime();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('calculates days remaining correctly using free_trial_end_at', () => {
    // Organization created 5 days before fixed now
    const createdAt = new Date(FIXED_NOW_MS - 5 * 24 * 60 * 60 * 1000).toISOString();

    // Organization with trial ending in 14 days
    const freeTrialEndAt14 = new Date(FIXED_NOW_MS + 14 * 24 * 60 * 60 * 1000).toISOString();
    expect(getDaysRemainingInTrial(freeTrialEndAt14, createdAt)).toBe(14);

    // Organization with trial expired 5 days ago
    const freeTrialEndAtExpired = new Date(FIXED_NOW_MS - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(getDaysRemainingInTrial(freeTrialEndAtExpired, createdAt)).toBe(-5);
  });

  it('falls back to created_at + 14 days when free_trial_end_at is null', () => {
    // Organization created today (no free_trial_end_at set)
    expect(getDaysRemainingInTrial(null, FIXED_NOW)).toBe(14);

    // Organization created 10 days ago (no free_trial_end_at set)
    const tenDaysAgo = new Date(FIXED_NOW_MS - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(getDaysRemainingInTrial(null, tenDaysAgo)).toBe(4);

    // Organization created 14 days ago (expires today, no free_trial_end_at set)
    const fourteenDaysAgo = new Date(FIXED_NOW_MS - 14 * 24 * 60 * 60 * 1000).toISOString();
    expect(getDaysRemainingInTrial(null, fourteenDaysAgo)).toBe(0);

    // Organization created 19 days ago (expired 5 days ago, no free_trial_end_at set)
    const nineteenDaysAgo = new Date(FIXED_NOW_MS - 19 * 24 * 60 * 60 * 1000).toISOString();
    expect(getDaysRemainingInTrial(null, nineteenDaysAgo)).toBe(-5);
  });
});
