import { describe, expect, it } from '@jest/globals';

import {
  canSchedulePlanChange,
  getCancellationWithdrawalNotice,
  willWithdrawCancellation,
} from './kiloPassPlanChange.logic';

describe('canSchedulePlanChange', () => {
  it('allows an active subscription', () => {
    expect(canSchedulePlanChange({ status: 'active', cancelAtPeriodEnd: false })).toBe(true);
  });

  it('allows an active subscription that is pending cancellation', () => {
    expect(canSchedulePlanChange({ status: 'active', cancelAtPeriodEnd: true })).toBe(true);
  });

  it.each(['past_due', 'incomplete', 'paused', 'trialing', 'canceled', 'unpaid'])(
    'blocks a %s subscription even when pending cancellation',
    status => {
      expect(canSchedulePlanChange({ status, cancelAtPeriodEnd: true })).toBe(false);
      expect(canSchedulePlanChange({ status, cancelAtPeriodEnd: false })).toBe(false);
    }
  );
});

describe('willWithdrawCancellation', () => {
  it('is true for an active, cancelling subscription with no scheduled change', () => {
    expect(willWithdrawCancellation({ status: 'active', cancelAtPeriodEnd: true }, false)).toBe(
      true
    );
  });

  it('is false when the subscription is not cancelling', () => {
    expect(willWithdrawCancellation({ status: 'active', cancelAtPeriodEnd: false }, false)).toBe(
      false
    );
  });

  it('is false when a change is already scheduled', () => {
    expect(willWithdrawCancellation({ status: 'active', cancelAtPeriodEnd: true }, true)).toBe(
      false
    );
  });

  it('is false when plan changes are not allowed for the status', () => {
    expect(willWithdrawCancellation({ status: 'past_due', cancelAtPeriodEnd: true }, false)).toBe(
      false
    );
  });
});

describe('getCancellationWithdrawalNotice', () => {
  it('names the date the new plan is billed', () => {
    const notice = getCancellationWithdrawalNotice({ effectiveAtLabel: 'Nov 1, 2026' });

    expect(notice).toContain('keeps it active');
    expect(notice).toContain('billed for the new plan on Nov 1, 2026');
  });

  it('falls back to generic wording when the date is unknown', () => {
    const notice = getCancellationWithdrawalNotice({ effectiveAtLabel: null });

    expect(notice).toContain('billed for the new plan on your next billing date');
  });
});
