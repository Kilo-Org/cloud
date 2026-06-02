import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyOrganizationEntitlement,
  getDaysRemainingInTrial,
  getOrgTrialStatusFromDays,
  type OrganizationEntitlementOrganization,
  type OrganizationSeatPurchaseSubscriptionStatus,
} from '..';

describe('getOrgTrialStatusFromDays', () => {
  it('maps active, ending, and expired day ranges', () => {
    expect(getOrgTrialStatusFromDays(14)).toBe('trial_active');
    expect(getOrgTrialStatusFromDays(8)).toBe('trial_active');
    expect(getOrgTrialStatusFromDays(7)).toBe('trial_ending_soon');
    expect(getOrgTrialStatusFromDays(4)).toBe('trial_ending_soon');
    expect(getOrgTrialStatusFromDays(3)).toBe('trial_ending_very_soon');
    expect(getOrgTrialStatusFromDays(1)).toBe('trial_ending_very_soon');
    expect(getOrgTrialStatusFromDays(0)).toBe('trial_expires_today');
    expect(getOrgTrialStatusFromDays(-1)).toBe('trial_expired_soft');
    expect(getOrgTrialStatusFromDays(-3)).toBe('trial_expired_soft');
    expect(getOrgTrialStatusFromDays(-4)).toBe('trial_expired_hard');
  });
});

describe('getDaysRemainingInTrial', () => {
  const fixedNow = '2024-01-15T12:00:00.000Z';
  const fixedNowMs = new Date(fixedNow).getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNow));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses explicit trial deadlines and created-at fallback', () => {
    const createdAt = new Date(fixedNowMs - 5 * 24 * 60 * 60 * 1000).toISOString();
    const explicitFutureDeadline = new Date(fixedNowMs + 14 * 24 * 60 * 60 * 1000).toISOString();
    const explicitPastDeadline = new Date(fixedNowMs - 5 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(fixedNowMs - 10 * 24 * 60 * 60 * 1000).toISOString();

    expect(getDaysRemainingInTrial(explicitFutureDeadline, createdAt)).toBe(14);
    expect(getDaysRemainingInTrial(explicitPastDeadline, createdAt)).toBe(-5);
    expect(getDaysRemainingInTrial(null, fixedNow)).toBe(14);
    expect(getDaysRemainingInTrial(null, tenDaysAgo)).toBe(4);
  });
});

describe('classifyOrganizationEntitlement', () => {
  const now = new Date('2026-05-18T12:00:00.000Z');
  const hardExpiredTrialEnd = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const softExpiredTrialEnd = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

  function classify(
    organizationOverrides: Partial<OrganizationEntitlementOrganization> = {},
    latestSeatPurchaseStatus: OrganizationSeatPurchaseSubscriptionStatus | null = null
  ) {
    const { settings, ...organizationFields } = organizationOverrides;
    const organization: OrganizationEntitlementOrganization = {
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
      now,
    });
  }

  it('enforces hard-expired unentitled organizations but not soft-expired ones', () => {
    expect(classify()).toMatchObject({
      bypassReason: null,
      displayStatus: 'trial_expired_hard',
      hasEntitlement: false,
      hasPaidSeatEntitlement: false,
      isTrialExpiredForEnforcement: true,
      trialStatus: 'trial_expired_hard',
    });
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
  ] satisfies OrganizationSeatPurchaseSubscriptionStatus[])(
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
  ] satisfies Array<[string, Partial<OrganizationEntitlementOrganization>]>)(
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
