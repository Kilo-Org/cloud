/* eslint-disable max-lines -- the test file covers every payment provider and platform pairing */
import { describe, expect, it, vi } from 'vitest';

import { formatDate } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';
import { KILO_PASS_MANAGE_CTA_LABEL, KILO_PASS_TITLE } from '@kilocode/app-shared/commerce';

import { getKiloPassSubscriptionCardContentState } from './subscription-card-state';

vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => 'en',
}));

const activeAppStoreSubscription = {
  cancelAtPeriodEnd: false,
  currentPeriodBaseCreditsUsd: 19,
  paymentProvider: 'app_store' as const,
  refillAt: '2026-06-08T15:21:05.000Z',
  status: 'active',
};

const endDate = formatDate(parseTimestamp(activeAppStoreSubscription.refillAt), 'en');

describe('getKiloPassSubscriptionCardContentState', () => {
  it('keeps pending presentation or state non-actionable while loading', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: undefined,
        presentationIsError: false,
        presentationIsPending: true,
        subscription: undefined,
        stateIsError: false,
        stateIsPending: false,
        platformOS: 'ios',
      })
    ).toEqual({ kind: 'loading' });
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: { kind: 'native_iap', statusClass: 'healthy' },
        presentationIsError: false,
        presentationIsPending: false,
        subscription: undefined,
        stateIsError: false,
        stateIsPending: true,
        platformOS: 'ios',
      })
    ).toEqual({ kind: 'loading' });
  });

  it('keeps presentation or state errors on retry', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: undefined,
        presentationIsError: true,
        presentationIsPending: false,
        subscription: undefined,
        stateIsError: false,
        stateIsPending: false,
        platformOS: 'ios',
      })
    ).toEqual({
      actionLabel: 'Retry',
      description: 'Try again from Profile.',
      kind: 'error',
      title: 'Kilo Pass unavailable',
    });
  });

  it('keeps a missing presentation loading', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: undefined,
        presentationIsError: false,
        presentationIsPending: false,
        subscription: undefined,
        stateIsError: false,
        stateIsPending: false,
        platformOS: 'ios',
      })
    ).toEqual({ kind: 'loading' });
  });

  it('renders the unavailable surface without a purchase CTA', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: { kind: 'unavailable', statusClass: 'inactive' },
        presentationIsError: false,
        presentationIsPending: false,
        subscription: null,
        stateIsError: false,
        stateIsPending: false,
        platformOS: 'android',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'open-native',
        actionLabel: null,
        description: 'Kilo Pass purchase is not available right now.',
        title: KILO_PASS_TITLE,
      },
    });
  });

  it('renders the web-management surface with a Manage action', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: { kind: 'web_management', statusClass: 'healthy' },
        presentationIsError: false,
        presentationIsPending: false,
        subscription: null,
        stateIsError: false,
        stateIsPending: false,
        platformOS: 'android',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'open-web',
        actionLabel: KILO_PASS_MANAGE_CTA_LABEL,
        description: 'This Kilo Pass is managed on web',
        title: KILO_PASS_TITLE,
      },
    });
  });

  it('shows subscribe only for native_iap without a live subscription', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: { kind: 'native_iap', statusClass: 'inactive' },
        presentationIsError: false,
        presentationIsPending: false,
        subscription: null,
        stateIsError: false,
        stateIsPending: false,
        platformOS: 'ios',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'open-native',
        actionLabel: 'Subscribe',
        description: 'Monthly credits with bonus progress',
        title: KILO_PASS_TITLE,
      },
    });
  });

  it('renders active App Store subscriptions on native_iap', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: { kind: 'native_iap', statusClass: 'healthy' },
        presentationIsError: false,
        presentationIsPending: false,
        subscription: activeAppStoreSubscription,
        stateIsError: false,
        stateIsPending: false,
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

  it('renders canceling App Store subscriptions on native_iap', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: { kind: 'native_iap', statusClass: 'healthy' },
        presentationIsError: false,
        presentationIsPending: false,
        subscription: { ...activeAppStoreSubscription, cancelAtPeriodEnd: true },
        stateIsError: false,
        stateIsPending: false,
        platformOS: 'ios',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'open-store-management',
        actionLabel: 'Manage',
        description: `$19 monthly credits · Ends ${endDate}`,
        title: 'Kilo Pass canceling',
      },
    });
  });

  it('renders Google Play subscriptions as actionable management cards', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: { kind: 'native_iap', statusClass: 'healthy' },
        presentationIsError: false,
        presentationIsPending: false,
        subscription: {
          cancelAtPeriodEnd: false,
          currentPeriodBaseCreditsUsd: 49,
          paymentProvider: 'google_play',
          refillAt: '2026-06-08T15:21:05.000Z',
          status: 'active',
        },
        stateIsError: false,
        stateIsPending: false,
        platformOS: 'android',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'open-store-management',
        actionLabel: 'Manage',
        description: '$49 monthly credits · Managed on Google Play',
        title: 'Kilo Pass active',
      },
    });
  });

  it('renders canceling Google Play subscriptions with an end date', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: { kind: 'native_iap', statusClass: 'healthy' },
        presentationIsError: false,
        presentationIsPending: false,
        subscription: {
          cancelAtPeriodEnd: true,
          currentPeriodBaseCreditsUsd: 49,
          paymentProvider: 'google_play',
          refillAt: '2026-06-08T15:21:05.000Z',
          status: 'active',
        },
        stateIsError: false,
        stateIsPending: false,
        platformOS: 'android',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'open-store-management',
        actionLabel: 'Manage',
        description: `$49 monthly credits · Ends ${endDate}`,
        title: 'Kilo Pass canceling',
      },
    });
  });

  it('renders a Google Play subscription owned on an iOS device as inert', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: { kind: 'native_iap', statusClass: 'healthy' },
        presentationIsError: false,
        presentationIsPending: false,
        subscription: {
          cancelAtPeriodEnd: false,
          currentPeriodBaseCreditsUsd: 49,
          paymentProvider: 'google_play',
          refillAt: '2026-06-08T15:21:05.000Z',
          status: 'active',
        },
        stateIsError: false,
        stateIsPending: false,
        platformOS: 'ios',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'none',
        actionLabel: null,
        description: '$49 monthly credits · Managed on Google Play',
        title: 'Kilo Pass active',
      },
    });
  });

  it('renders a canceling Google Play subscription owned on an iOS device as inert', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: { kind: 'native_iap', statusClass: 'healthy' },
        presentationIsError: false,
        presentationIsPending: false,
        subscription: {
          cancelAtPeriodEnd: true,
          currentPeriodBaseCreditsUsd: 49,
          paymentProvider: 'google_play',
          refillAt: '2026-06-08T15:21:05.000Z',
          status: 'active',
        },
        stateIsError: false,
        stateIsPending: false,
        platformOS: 'ios',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'none',
        actionLabel: null,
        description: `$49 monthly credits · Ends ${endDate} · Managed on Google Play`,
        title: 'Kilo Pass canceling',
      },
    });
  });

  it('renders an App Store subscription owned on a Play device as inert', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: { kind: 'native_iap', statusClass: 'healthy' },
        presentationIsError: false,
        presentationIsPending: false,
        subscription: activeAppStoreSubscription,
        stateIsError: false,
        stateIsPending: false,
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

  it('renders Stripe-managed subscriptions as inert status cards on native_iap', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: { kind: 'native_iap', statusClass: 'healthy' },
        presentationIsError: false,
        presentationIsPending: false,
        subscription: {
          cancelAtPeriodEnd: false,
          currentPeriodBaseCreditsUsd: 49,
          paymentProvider: 'stripe',
          refillAt: '2026-06-08T15:21:05.000Z',
          status: 'active',
        },
        stateIsError: false,
        stateIsPending: false,
        platformOS: 'ios',
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'none',
        actionLabel: null,
        description: '$49 monthly credits · This Kilo Pass is managed on web',
        title: 'Kilo Pass active',
      },
    });
  });
});
