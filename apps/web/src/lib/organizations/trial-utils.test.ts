import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { OrganizationSeatsPurchase } from '@kilocode/db/schema';
import {
  classifyOrganizationEntitlement,
  getOrgTrialStatusFromDays,
  getDaysRemainingInTrial,
} from './trial-utils';

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

describe('classifyOrganizationEntitlement', () => {
  const NOW = new Date('2026-05-18T12:00:00.000Z');
  const hardExpiredTrialEnd = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const softExpiredTrialEnd = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  type EntitlementOrganization = Parameters<
    typeof classifyOrganizationEntitlement
  >[0]['organization'];

  function classify(
    organizationOverrides: Partial<EntitlementOrganization> = {},
    latestSeatPurchaseStatus: OrganizationSeatsPurchase['subscription_status'] | null = null
  ) {
    const { settings, ...organizationFields } = organizationOverrides;
    const organization: EntitlementOrganization = {
      created_at: '2026-05-01T12:00:00.000Z',
      free_trial_end_at: hardExpiredTrialEnd,
      require_seats: true,
      ...organizationFields,
      settings: {
        ...settings,
      },
    };

    return classifyOrganizationEntitlement({
      organization,
      latestSeatPurchaseStatus,
      now: NOW,
    });
  }

  it('marks hard-expired unentitled organizations as expired for enforcement', () => {
    expect(classify()).toMatchObject({
      bypassReason: null,
      displayStatus: 'trial_expired_hard',
      hasEntitlement: false,
      hasPaidSeatEntitlement: false,
      isTrialExpiredForEnforcement: true,
      trialStatus: 'trial_expired_hard',
    });
  });

  it('keeps soft-expired organizations entitled for server enforcement', () => {
    expect(classify({ free_trial_end_at: softExpiredTrialEnd })).toMatchObject({
      bypassReason: null,
      displayStatus: 'trial_expired_soft',
      hasEntitlement: true,
      isTrialExpiredForEnforcement: false,
      trialStatus: 'trial_expired_soft',
    });
  });

  it.each([
    'active',
    'pending_cancel',
    'incomplete',
    'incomplete_expired',
    'trialing',
    'past_due',
    'canceled',
    'unpaid',
    'paused',
  ] satisfies OrganizationSeatsPurchase['subscription_status'][])(
    'treats %s seat purchases as paid entitlement until ended',
    subscriptionStatus => {
      expect(classify({}, subscriptionStatus)).toMatchObject({
        bypassReason: 'paid_seat_purchase',
        displayStatus: 'subscribed',
        hasEntitlement: true,
        hasPaidSeatEntitlement: true,
        isTrialExpiredForEnforcement: false,
      });
    }
  );

  it('does not treat ended seat purchases as paid entitlement', () => {
    expect(classify({}, 'ended')).toMatchObject({
      bypassReason: null,
      displayStatus: 'trial_expired_hard',
      hasEntitlement: false,
      hasPaidSeatEntitlement: false,
      isTrialExpiredForEnforcement: true,
    });
  });

  it.each([
    ['require_seats_disabled', { require_seats: false }],
    ['oss_sponsorship', { settings: { oss_sponsorship_tier: 1 } }],
    ['trial_messaging_suppressed', { settings: { suppress_trial_messaging: true } }],
  ] satisfies Array<[string, Partial<EntitlementOrganization>]>)(
    'reports %s bypasses as subscribed',
    (bypassReason, organizationOverrides) => {
      expect(classify(organizationOverrides)).toMatchObject({
        bypassReason,
        displayStatus: 'subscribed',
        hasEntitlement: true,
        hasPaidSeatEntitlement: false,
        isTrialExpiredForEnforcement: false,
      });
    }
  );
});
