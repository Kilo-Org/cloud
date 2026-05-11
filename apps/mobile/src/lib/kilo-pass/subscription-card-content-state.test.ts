import { describe, expect, it } from 'vitest';

import { getKiloPassSubscriptionCardContentState } from './subscription-card-state';

const activeAppStoreSubscription = {
  cancelAtPeriodEnd: false,
  currentPeriodBaseCreditsUsd: 19,
  paymentProvider: 'app_store' as const,
  refillAt: '2026-06-08T15:21:05.000Z',
  status: 'active',
};

describe('getKiloPassSubscriptionCardContentState', () => {
  it('keeps unresolved iOS state non-actionable while loading', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        data: undefined,
        isError: false,
        isPending: true,
        platformOS: 'ios',
      })
    ).toEqual({ kind: 'loading' });
  });

  it('keeps unresolved iOS errors on retry instead of subscribe', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        data: undefined,
        isError: true,
        isPending: false,
        platformOS: 'ios',
      })
    ).toEqual({
      actionLabel: 'Retry',
      description: 'Try again from Profile.',
      kind: 'error',
      title: 'Kilo Pass unavailable',
    });
  });

  it('keeps Android pending and error states away from subscribe', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        data: undefined,
        isError: false,
        isPending: true,
        platformOS: 'android',
      })
    ).toEqual({ kind: 'loading' });
    expect(
      getKiloPassSubscriptionCardContentState({
        data: undefined,
        isError: true,
        isPending: false,
        platformOS: 'android',
      })
    ).toEqual({
      actionLabel: 'Retry',
      description: 'Try again from Profile.',
      kind: 'error',
      title: 'Kilo Pass unavailable',
    });
  });

  it('shows subscribe only after iOS returns a confirmed null subscription', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        data: { subscription: null },
        isError: false,
        isPending: false,
        platformOS: 'ios',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'open-store-sheet',
        actionLabel: 'Subscribe',
        description: 'Monthly credits with bonus progress',
        title: 'Kilo Pass',
      },
    });
  });

  it('renders an inert iOS ownership mismatch before subscribe', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        appStoreOwnershipPreflight: 'owned-by-another-account',
        data: { subscription: null },
        isError: false,
        isPending: false,
        platformOS: 'ios',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'none',
        actionLabel: null,
        description: 'Kilo Pass subscription is owned by another account',
        title: 'Kilo Pass',
      },
    });
  });

  it('does not override an active local subscription with ownership preflight copy', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        appStoreOwnershipPreflight: 'owned-by-another-account',
        data: { subscription: activeAppStoreSubscription },
        isError: false,
        isPending: false,
        platformOS: 'ios',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'open-store-management',
        actionLabel: 'Manage',
        description: '$19 monthly credits · Managed in App Store',
        title: 'Kilo Pass active',
      },
    });
  });

  it('keeps confirmed null subscriptions hidden on Android', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        data: { subscription: null },
        isError: false,
        isPending: false,
        platformOS: 'android',
      })
    ).toEqual({ kind: 'hidden' });
  });

  it('renders active App Store subscriptions on iOS', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        data: { subscription: activeAppStoreSubscription },
        isError: false,
        isPending: false,
        platformOS: 'ios',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'open-store-management',
        actionLabel: 'Manage',
        description: '$19 monthly credits · Managed in App Store',
        title: 'Kilo Pass active',
      },
    });
  });

  it('renders canceling App Store subscriptions on iOS', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        data: {
          subscription: {
            ...activeAppStoreSubscription,
            cancelAtPeriodEnd: true,
          },
        },
        isError: false,
        isPending: false,
        platformOS: 'ios',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'open-store-management',
        actionLabel: 'Manage',
        description: '$19 monthly credits · Ends June 8, 2026',
        title: 'Kilo Pass canceling',
      },
    });
  });

  it('renders active App Store subscriptions as inert status cards on Android', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        data: { subscription: activeAppStoreSubscription },
        isError: false,
        isPending: false,
        platformOS: 'android',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'none',
        actionLabel: null,
        description: '$19 monthly credits · Managed in App Store',
        title: 'Kilo Pass active',
      },
    });
  });

  it('renders canceling App Store subscriptions as inert status cards on Android', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        data: {
          subscription: {
            ...activeAppStoreSubscription,
            cancelAtPeriodEnd: true,
          },
        },
        isError: false,
        isPending: false,
        platformOS: 'android',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'none',
        actionLabel: null,
        description: '$19 monthly credits · Ends June 8, 2026 · Managed in App Store',
        title: 'Kilo Pass canceling',
      },
    });
  });
});
