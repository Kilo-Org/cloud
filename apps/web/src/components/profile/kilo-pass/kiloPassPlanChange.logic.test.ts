import { describe, expect, it } from '@jest/globals';

import { getPlanChangeBlockedReason } from './kiloPassPlanChange.logic';

describe('getPlanChangeBlockedReason', () => {
  it('asks the user to resume an active subscription that is pending cancellation', () => {
    expect(getPlanChangeBlockedReason({ status: 'active', cancelAtPeriodEnd: true })).toContain(
      'Resume your subscription'
    );
  });

  it('has no reason for an active subscription that is not cancelling', () => {
    expect(getPlanChangeBlockedReason({ status: 'active', cancelAtPeriodEnd: false })).toBeNull();
  });

  it('has no cancellation reason for a subscription that is not active', () => {
    expect(getPlanChangeBlockedReason({ status: 'past_due', cancelAtPeriodEnd: true })).toBeNull();
  });
});
