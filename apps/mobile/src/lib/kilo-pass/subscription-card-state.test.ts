import { describe, expect, it } from 'vitest';

import { getKiloPassSubscriptionCardState } from './subscription-card-state';

describe('getKiloPassSubscriptionCardState', () => {
  it('sends Stripe-managed Kilo Pass users to web management', () => {
    expect(
      getKiloPassSubscriptionCardState({
        currentPeriodBaseCreditsUsd: 49,
        paymentProvider: 'stripe',
      })
    ).toEqual({
      action: 'open-web-management',
      actionLabel: 'Manage on web',
      description: '$49 monthly credits · Managed on web',
      title: 'Kilo Pass active',
    });
  });

  it('keeps unsubscribed users on the App Store purchase path', () => {
    expect(getKiloPassSubscriptionCardState(null)).toEqual({
      action: 'open-store-sheet',
      actionLabel: 'Subscribe',
      description: 'Monthly credits with bonus progress',
      title: 'Kilo Pass',
    });
  });

  it('sends App Store-managed Kilo Pass users to App Store management', () => {
    expect(
      getKiloPassSubscriptionCardState({
        currentPeriodBaseCreditsUsd: 19,
        paymentProvider: 'app_store',
      })
    ).toEqual({
      action: 'open-store-management',
      actionLabel: 'Manage',
      description: '$19 monthly credits',
      title: 'Kilo Pass active',
    });
  });
});
