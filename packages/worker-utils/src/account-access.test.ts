import { describe, expect, it } from 'vitest';
import {
  accountBalanceMicrodollars,
  blacklistedDomainsFromConfig,
  canSpendPaidUsage,
  isApiTokenPepperCurrent,
  isEmailBlacklistedByDomain,
  organizationMemberBalance,
  requestOrganizationId,
} from './account-access';

const organization = {
  total_microdollars_acquired: 5_000,
  microdollars_used: 1_000,
  inference_microdollars_held: 0,
};

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
    const limited = {
      microdollar_limit: 500,
      microdollar_usage: 500,
      member_inference_microdollars_held: 0,
    };
    expect(organizationMemberBalance({ ...organization, ...limited, require_seats: true })).toEqual(
      { balanceMicrodollars: 4_000, limitedByUserAllowance: false }
    );
    expect(
      organizationMemberBalance({
        ...organization,
        microdollar_limit: null,
        microdollar_usage: null,
        member_inference_microdollars_held: 0,
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
        member_inference_microdollars_held: 0,
        require_seats: false,
      })
    ).toEqual({ balanceMicrodollars: 1_000, limitedByUserAllowance: false });
    expect(
      organizationMemberBalance({
        ...organization,
        microdollar_limit: 9_000,
        microdollar_usage: null,
        member_inference_microdollars_held: 0,
        require_seats: false,
      })
    ).toEqual({ balanceMicrodollars: 4_000, limitedByUserAllowance: false });
    expect(
      organizationMemberBalance({
        ...organization,
        microdollar_limit: 500,
        microdollar_usage: 700,
        require_seats: false,
        member_inference_microdollars_held: 0,
      })
    ).toEqual({ balanceMicrodollars: -200, limitedByUserAllowance: true });
  });

  it('prevents paid usage when the remaining account balance is fully held', () => {
    const balance = accountBalanceMicrodollars({
      ...organization,
      inference_microdollars_held: 4_000,
    });
    expect(balance).toBe(0);
    expect(canSpendPaidUsage(balance)).toBe(false);
    expect(
      organizationMemberBalance({
        ...organization,
        inference_microdollars_held: 4_000,
        microdollar_limit: null,
        microdollar_usage: null,
        member_inference_microdollars_held: 0,
        require_seats: false,
      })
    ).toEqual({ balanceMicrodollars: 0, limitedByUserAllowance: false });
  });

  it('exhausts member allowance when usage and member holds reach its limit', () => {
    expect(
      organizationMemberBalance({
        ...organization,
        inference_microdollars_held: 500,
        microdollar_limit: 1_500,
        microdollar_usage: 1_000,
        member_inference_microdollars_held: 500,
        require_seats: false,
      })
    ).toEqual({ balanceMicrodollars: 0, limitedByUserAllowance: true });
  });

  it('preserves negative account and member balances after subtracting holds', () => {
    expect(
      accountBalanceMicrodollars({
        ...organization,
        inference_microdollars_held: 4_200,
      })
    ).toBe(-200);
    expect(
      organizationMemberBalance({
        ...organization,
        inference_microdollars_held: 4_200,
        microdollar_limit: 1_500,
        microdollar_usage: 500,
        member_inference_microdollars_held: 0,
        require_seats: false,
      })
    ).toEqual({ balanceMicrodollars: -200, limitedByUserAllowance: false });
    expect(
      organizationMemberBalance({
        ...organization,
        microdollar_limit: 1_500,
        microdollar_usage: 1_000,
        member_inference_microdollars_held: 700,
        require_seats: false,
      })
    ).toEqual({ balanceMicrodollars: -200, limitedByUserAllowance: true });
  });

  it('ignores member holds for seats but still subtracts organization holds', () => {
    const member = {
      ...organization,
      inference_microdollars_held: 1_000,
      microdollar_limit: 500,
      microdollar_usage: 500,
      member_inference_microdollars_held: 700,
      require_seats: true,
    };
    expect(organizationMemberBalance(member)).toEqual({
      balanceMicrodollars: 3_000,
      limitedByUserAllowance: false,
    });
    expect(organizationMemberBalance({ ...member, inference_microdollars_held: 4_000 })).toEqual({
      balanceMicrodollars: 0,
      limitedByUserAllowance: false,
    });
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
