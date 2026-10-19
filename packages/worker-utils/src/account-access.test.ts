import { describe, expect, it } from 'vitest';
import {
  blacklistedDomainsFromConfig,
  canSpendPaidUsage,
  isApiTokenPepperCurrent,
  isEmailBlacklistedByDomain,
  organizationMemberBalance,
  requestOrganizationId,
} from './account-access';

const organization = { total_microdollars_acquired: 5_000, microdollars_used: 1_000 };

describe('account access rules', () => {
  it('lets a signed organization claim win over the mutable header', () => {
    expect(requestOrganizationId('signed-org', 'header-org')).toBe('signed-org');
    expect(requestOrganizationId(undefined, 'header-org')).toBe('header-org');
    expect(requestOrganizationId(undefined, null)).toBeUndefined();
  });

  it('accepts any token for an account without a pepper and otherwise requires the current one', () => {
    expect(isApiTokenPepperCurrent(null, undefined)).toBe(true);
    expect(isApiTokenPepperCurrent('current', 'current')).toBe(true);
    expect(isApiTokenPepperCurrent('current', 'rotated')).toBe(false);
    expect(isApiTokenPepperCurrent('current', undefined)).toBe(false);
  });

  it('ignores member limits for seat-based organizations and unlimited members', () => {
    const limited = { microdollar_limit: 500, microdollar_usage: 500 };
    expect(organizationMemberBalance({ ...organization, ...limited, require_seats: true })).toEqual(
      { balanceMicrodollars: 4_000, limitedByUserAllowance: false }
    );
    expect(
      organizationMemberBalance({
        ...organization,
        microdollar_limit: null,
        microdollar_usage: null,
        require_seats: false,
      })
    ).toEqual({ balanceMicrodollars: 4_000, limitedByUserAllowance: false });
  });

  it('caps a limited member at the smaller of allowance and organization balance', () => {
    expect(
      organizationMemberBalance({
        ...organization,
        microdollar_limit: 1_500,
        microdollar_usage: 500,
        require_seats: false,
      })
    ).toEqual({ balanceMicrodollars: 1_000, limitedByUserAllowance: false });
    expect(
      organizationMemberBalance({
        ...organization,
        microdollar_limit: 9_000,
        microdollar_usage: null,
        require_seats: false,
      })
    ).toEqual({ balanceMicrodollars: 4_000, limitedByUserAllowance: false });
    expect(
      organizationMemberBalance({
        ...organization,
        microdollar_limit: 500,
        microdollar_usage: 700,
        require_seats: false,
      })
    ).toEqual({ balanceMicrodollars: -200, limitedByUserAllowance: true });
  });

  it('requires a positive balance for paid usage', () => {
    expect(canSpendPaidUsage(0.000001)).toBe(true);
    expect(canSpendPaidUsage(0)).toBe(false);
    expect(canSpendPaidUsage(-1)).toBe(false);
  });

  it('blocks a listed email domain and its subdomains, case-insensitively', () => {
    const domains = ['Spam.com'];
    expect(isEmailBlacklistedByDomain('user@SPAM.com', domains)).toBe(true);
    expect(isEmailBlacklistedByDomain('user@mail.spam.com', domains)).toBe(true);
    expect(isEmailBlacklistedByDomain('user@notspam.com', domains)).toBe(false);
    expect(isEmailBlacklistedByDomain('spam.com@legitimate.org', domains)).toBe(false);
    expect(isEmailBlacklistedByDomain('user@spam.com', undefined)).toBe(false);
  });

  it('reads blocked domains from the admin config and falls back when it is empty', () => {
    const config = (domains: string[]) =>
      JSON.stringify({ domains, updated_at: null, updated_by: null, updated_by_email: null });
    expect(blacklistedDomainsFromConfig(config(['spam.com']), ['env.com'])).toEqual(['spam.com']);
    expect(blacklistedDomainsFromConfig(config([]), ['env.com'])).toEqual(['env.com']);
    expect(blacklistedDomainsFromConfig(null, ['env.com'])).toEqual(['env.com']);
  });
});
