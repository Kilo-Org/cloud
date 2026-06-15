import { describe, expect, it } from 'vitest';

import {
  getKiloPassSubscriptionCardAccessibility,
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

  it('keeps Stripe-managed Kilo Pass inert on iOS', () => {
    expect(
      getKiloPassSubscriptionCardState(
        {
          cancelAtPeriodEnd: false,
          currentPeriodBaseCreditsUsd: 49,
          paymentProvider: 'stripe',
          refillAt: '2026-06-08T15:21:05.000Z',
          status: 'active',
        },
        { platformOS: 'ios' }
      )
    ).toEqual({
      action: 'none',
      actionLabel: null,
      description: '$49 monthly credits · This Kilo Pass is managed on web',
      title: 'Kilo Pass active',
    });
  });

  it('keeps canceling Stripe-managed Kilo Pass inert on iOS', () => {
    expect(
      getKiloPassSubscriptionCardState(
        {
          cancelAtPeriodEnd: true,
          currentPeriodBaseCreditsUsd: 49,
          paymentProvider: 'stripe',
          refillAt: '2026-06-08T15:21:05.000Z',
          status: 'active',
        },
        { platformOS: 'ios' }
      )
    ).toEqual({
      action: 'none',
      actionLabel: null,
      description: '$49 monthly credits · Ends June 8, 2026 · This Kilo Pass is managed on web',
      title: 'Kilo Pass canceling',
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

  it('rejects unresolved subscription data instead of treating it as unsubscribed', () => {
    expect(() => getKiloPassSubscriptionCardState(undefined)).toThrow(
      'Kilo Pass subscription card state requires resolved subscription data.'
    );
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

  it('keeps active App Store-managed subscriptions inert on Android', () => {
    expect(
      getKiloPassSubscriptionCardState(
        {
          cancelAtPeriodEnd: false,
          currentPeriodBaseCreditsUsd: 19,
          paymentProvider: 'app_store',
          refillAt: '2026-06-08T15:21:05.000Z',
          status: 'active',
        },
        { platformOS: 'android' }
      )
    ).toEqual({
      action: 'none',
      actionLabel: null,
      description: '$19 monthly credits · Managed in App Store',
      title: 'Kilo Pass active',
    });
  });

  it('keeps canceling App Store-managed subscriptions inert on Android', () => {
    expect(
      getKiloPassSubscriptionCardState(
        {
          cancelAtPeriodEnd: true,
          currentPeriodBaseCreditsUsd: 19,
          paymentProvider: 'app_store',
          refillAt: '2026-06-08T15:21:05.000Z',
          status: 'active',
        },
        { platformOS: 'android' }
      )
    ).toEqual({
      action: 'none',
      actionLabel: null,
      description: '$19 monthly credits · Ends June 8, 2026 · Managed in App Store',
      title: 'Kilo Pass canceling',
    });
  });

  it('keeps active Google Play-managed subscriptions inert', () => {
    expect(
      getKiloPassSubscriptionCardState({
        cancelAtPeriodEnd: false,
        currentPeriodBaseCreditsUsd: 49,
        paymentProvider: 'google_play',
        refillAt: '2026-06-08T15:21:05.000Z',
        status: 'active',
      })
    ).toEqual({
      action: 'none',
      actionLabel: null,
      description: '$49 monthly credits · Managed on Google Play',
      title: 'Kilo Pass active',
    });
  });

  it('keeps canceling Google Play-managed subscriptions inert', () => {
    expect(
      getKiloPassSubscriptionCardState({
        cancelAtPeriodEnd: true,
        currentPeriodBaseCreditsUsd: 49,
        paymentProvider: 'google_play',
        refillAt: '2026-06-08T15:21:05.000Z',
        status: 'active',
      })
    ).toEqual({
      action: 'none',
      actionLabel: null,
      description: '$49 monthly credits · Ends June 8, 2026 · Managed on Google Play',
      title: 'Kilo Pass canceling',
    });
  });

  it('formats backend PostgreSQL timestamps for pending cancellation', () => {
    expect(
      getKiloPassSubscriptionCardState({
        cancelAtPeriodEnd: true,
        currentPeriodBaseCreditsUsd: 19,
        paymentProvider: 'app_store',
        refillAt: '2026-06-08 15:21:05+00',
        status: 'active',
      }).description
    ).toContain('June 8, 2026');
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

  it('renders inert Android cards', () => {
    expect(
      shouldRenderKiloPassSubscriptionCard({
        action: 'none',
        platformOS: 'android',
      })
    ).toBe(true);
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

describe('getKiloPassSubscriptionCardAccessibility', () => {
  it('describes the subscribe action', () => {
    expect(
      getKiloPassSubscriptionCardAccessibility({
        action: 'open-store-sheet',
        actionLabel: 'Subscribe',
        description: 'Monthly credits with bonus progress',
        title: 'Kilo Pass',
      })
    ).toEqual({
      accessibilityHint: 'Opens Kilo Pass plans.',
      accessibilityLabel: 'Kilo Pass. Monthly credits with bonus progress. Subscribe',
    });
  });

  it('describes App Store management', () => {
    expect(
      getKiloPassSubscriptionCardAccessibility({
        action: 'open-store-management',
        actionLabel: 'Manage',
        description: '$19 monthly credits · Managed in App Store',
        title: 'Kilo Pass active',
      })
    ).toEqual({
      accessibilityHint: 'Opens App Store subscription management.',
      accessibilityLabel: 'Kilo Pass active. $19 monthly credits · Managed in App Store. Manage',
    });
  });

  it('describes web management', () => {
    expect(
      getKiloPassSubscriptionCardAccessibility({
        action: 'open-web-management',
        actionLabel: 'Manage',
        description: '$49 monthly credits · Managed on web',
        title: 'Kilo Pass active',
      })
    ).toEqual({
      accessibilityHint: 'Opens Kilo Pass management on web.',
      accessibilityLabel: 'Kilo Pass active. $49 monthly credits · Managed on web. Manage',
    });
  });
});
