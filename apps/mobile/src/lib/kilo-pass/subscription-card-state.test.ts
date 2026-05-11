import { describe, expect, it } from 'vitest';

import {
  getKiloPassSubscriptionCardState,
  shouldRenderKiloPassSubscriptionCard,
} from './subscription-card-state';

describe('getKiloPassSubscriptionCardState', () => {
  it('sends Stripe-managed Kilo Pass users to web management', () => {
    expect(
      getKiloPassSubscriptionCardState({
        cancelAtPeriodEnd: false,
        currentPeriodBaseCreditsUsd: 49,
        paymentProvider: 'stripe',
        refillAt: '2026-06-08T15:21:05.000Z',
        status: 'active',
      })
    ).toEqual({
      action: 'open-web-management',
      actionLabel: 'Manage',
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

  it('shows an informational state while checking App Store ownership', () => {
    expect(getKiloPassSubscriptionCardState(null, { appStoreOwnership: 'checking' })).toEqual({
      action: 'none',
      actionLabel: null,
      description: 'Checking App Store subscription',
      title: 'Kilo Pass',
    });
  });

  it('shows an informational state when App Store ownership belongs to another account', () => {
    expect(
      getKiloPassSubscriptionCardState(null, { appStoreOwnership: 'another-account' })
    ).toEqual({
      action: 'none',
      actionLabel: null,
      description: 'Kilo Pass subscription is owned by another account',
      title: 'Kilo Pass',
    });
  });

  it('shows an informational state while restoring current-account App Store ownership', () => {
    expect(
      getKiloPassSubscriptionCardState(null, { appStoreOwnership: 'current-account' })
    ).toEqual({
      action: 'none',
      actionLabel: null,
      description: 'Restoring App Store subscription',
      title: 'Kilo Pass',
    });
  });

  it('sends App Store-managed Kilo Pass users to App Store management', () => {
    expect(
      getKiloPassSubscriptionCardState({
        cancelAtPeriodEnd: false,
        currentPeriodBaseCreditsUsd: 19,
        paymentProvider: 'app_store',
        refillAt: '2026-06-08T15:21:05.000Z',
        status: 'active',
      })
    ).toEqual({
      action: 'open-store-management',
      actionLabel: 'Manage',
      description: '$19 monthly credits · Managed in App Store',
      title: 'Kilo Pass active',
    });
  });

  it('signals App Store-managed pending cancellation', () => {
    expect(
      getKiloPassSubscriptionCardState({
        cancelAtPeriodEnd: true,
        currentPeriodBaseCreditsUsd: 19,
        paymentProvider: 'app_store',
        refillAt: '2026-06-08T15:21:05.000Z',
        status: 'active',
      })
    ).toEqual({
      action: 'open-store-management',
      actionLabel: 'Manage',
      description: '$19 monthly credits · Ends June 8, 2026',
      title: 'Kilo Pass canceling',
    });
  });

  it('treats canceled App Store-managed subscriptions as unsubscribed', () => {
    expect(
      getKiloPassSubscriptionCardState({
        cancelAtPeriodEnd: false,
        currentPeriodBaseCreditsUsd: 19,
        paymentProvider: 'app_store',
        refillAt: '2026-06-08T15:21:05.000Z',
        status: 'canceled',
      })
    ).toEqual({
      action: 'open-store-sheet',
      actionLabel: 'Subscribe',
      description: 'Monthly credits with bonus progress',
      title: 'Kilo Pass',
    });
  });
});

describe('shouldRenderKiloPassSubscriptionCard', () => {
  it('renders Android cards that can be managed on web', () => {
    expect(
      shouldRenderKiloPassSubscriptionCard({
        action: 'open-web-management',
        platformOS: 'android',
      })
    ).toBe(true);
  });

  it('does not render Android cards that require store purchase or App Store management', () => {
    expect(
      shouldRenderKiloPassSubscriptionCard({
        action: 'open-store-sheet',
        platformOS: 'android',
      })
    ).toBe(false);
    expect(
      shouldRenderKiloPassSubscriptionCard({
        action: 'open-store-management',
        platformOS: 'android',
      })
    ).toBe(false);
  });

  it('keeps iOS store actions visible', () => {
    expect(
      shouldRenderKiloPassSubscriptionCard({
        action: 'open-store-sheet',
        platformOS: 'ios',
      })
    ).toBe(true);
    expect(
      shouldRenderKiloPassSubscriptionCard({
        action: 'open-store-management',
        platformOS: 'ios',
      })
    ).toBe(true);
  });
});
