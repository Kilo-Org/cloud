import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import {
  getKiloPassCardContentState,
  getKiloPassDetailState,
  type KiloPassSubscription,
} from './state';

function subscription(overrides: Partial<KiloPassSubscription> = {}): KiloPassSubscription {
  return {
    subscriptionId: 'kilo-pass-1',
    stripeSubscriptionId: 'sub_1',
    paymentProvider: 'stripe',
    providerSubscriptionId: null,
    tier: 'tier_49',
    cadence: 'monthly',
    status: 'active',
    cancelAtPeriodEnd: false,
    currentStreakMonths: 3,
    nextYearlyIssueAt: null,
    startedAt: '2026-01-05T00:00:00.000Z',
    resumesAt: null,
    nextBonusCreditsUsd: 9.8,
    nextBillingAt: '2026-12-05T12:00:00.000Z',
    isFirstTimeSubscriberEver: false,
    currentPeriodBaseCreditsUsd: 49,
    currentPeriodUsageUsd: 12.5,
    currentPeriodHostingCostUsd: 0,
    currentPeriodBonusCreditsUsd: 9.8,
    currentPeriodBonus: {
      status: 'available',
      kind: null,
      actualAmountUsd: null,
      projectedAmountUsd: 9.8,
    },
    isBonusUnlocked: false,
    isBonusAvailableToUnlock: true,
    refillAt: '2026-12-05T12:00:00.000Z',
    ...overrides,
  };
}

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('getKiloPassDetailState', () => {
  it('reports a pending query as loading', () => {
    expect(
      getKiloPassDetailState({ subscription: undefined, isError: false, isPending: true })
    ).toEqual({ kind: 'loading' });
  });

  it('keeps a failed query retryable, even with stale data', () => {
    expect(
      getKiloPassDetailState({ subscription: subscription(), isError: true, isPending: false })
    ).toEqual({ kind: 'error' });
  });

  it('reports the no-pass state when the account has never subscribed', () => {
    expect(
      getKiloPassDetailState({ subscription: null, isError: false, isPending: false })
    ).toEqual({ kind: 'none' });
  });

  it('reports an ended pass for a terminal provider status', () => {
    for (const status of ['canceled', 'unpaid', 'incomplete_expired']) {
      expect(
        getKiloPassDetailState({
          subscription: subscription({ status }),
          isError: false,
          isPending: false,
        })
      ).toEqual({ kind: 'ended' });
    }
  });

  it('describes an active pass with its plan, status, renewal, usage, and bonus', () => {
    expect(
      getKiloPassDetailState({
        subscription: subscription(),
        isError: false,
        isPending: false,
      })
    ).toEqual({
      kind: 'active',
      planLabel: 'Pro · Monthly',
      statusLabel: 'Active',
      rows: [
        { id: 'renewal', label: 'Renews', value: 'Dec 5, 2026' },
        { id: 'usage', label: "This month's usage", value: '$12.50 / $58.80' },
        { id: 'bonus', label: 'Available free bonus', value: '$9.80' },
      ],
    });
  });

  it('labels a scheduled cancellation with the day access ends', () => {
    const detail = getKiloPassDetailState({
      subscription: subscription({ cancelAtPeriodEnd: true }),
      isError: false,
      isPending: false,
    });

    if (detail.kind !== 'active') {
      throw new Error(`unexpected state: ${detail.kind}`);
    }
    expect(detail.statusLabel).toBe('Canceling');
    expect(detail.rows[0]).toEqual({
      id: 'renewal',
      label: 'Active until',
      value: 'Dec 5, 2026',
    });
  });

  it('prefers the resume date of a paused pass', () => {
    const detail = getKiloPassDetailState({
      subscription: subscription({
        status: 'paused',
        resumesAt: '2027-02-01T12:00:00.000Z',
      }),
      isError: false,
      isPending: false,
    });

    if (detail.kind !== 'active') {
      throw new Error(`unexpected state: ${detail.kind}`);
    }
    expect(detail.statusLabel).toBe('Paused');
    expect(detail.rows[0]).toEqual({
      id: 'renewal',
      label: 'Resumes',
      value: 'Feb 1, 2027',
    });
  });

  it('labels an issued referral bonus with the amount actually granted', () => {
    const detail = getKiloPassDetailState({
      subscription: subscription({
        currentPeriodBonus: {
          status: 'issued',
          kind: 'referral_bonus',
          actualAmountUsd: 5,
          projectedAmountUsd: 9.8,
        },
      }),
      isError: false,
      isPending: false,
    });

    if (detail.kind !== 'active') {
      throw new Error(`unexpected state: ${detail.kind}`);
    }
    expect(detail.rows[2]).toEqual({ id: 'bonus', label: 'Referral bonus', value: '$5.00' });
  });

  it('hides the usage and bonus rows when the period carries neither', () => {
    const detail = getKiloPassDetailState({
      subscription: subscription({
        currentPeriodBaseCreditsUsd: 0,
        currentPeriodBonus: null,
      }),
      isError: false,
      isPending: false,
    });

    if (detail.kind !== 'active') {
      throw new Error(`unexpected state: ${detail.kind}`);
    }
    expect(detail.rows.map(row => row.id)).toEqual(['renewal']);
  });

  it('falls back to the refill date when no billing date is known', () => {
    const detail = getKiloPassDetailState({
      subscription: subscription({ nextBillingAt: null }),
      isError: false,
      isPending: false,
    });

    if (detail.kind !== 'active') {
      throw new Error(`unexpected state: ${detail.kind}`);
    }
    expect(detail.rows[0]?.value).toBe('Dec 5, 2026');
  });
});

describe('getKiloPassCardContentState', () => {
  it('shows the loading card while the query is pending', () => {
    expect(
      getKiloPassCardContentState({ subscription: undefined, isError: false, isPending: true })
    ).toEqual({ kind: 'loading' });
  });

  it('keeps a failed query on the retry row', () => {
    expect(
      getKiloPassCardContentState({ subscription: undefined, isError: true, isPending: false })
    ).toEqual({
      kind: 'error',
      title: "Couldn't load Kilo Pass.",
      description: 'Try again from Profile.',
      actionLabel: 'Retry',
    });
  });

  it('tells a subscriber-less account that the app does not offer a pass', () => {
    expect(
      getKiloPassCardContentState({ subscription: null, isError: false, isPending: false })
    ).toEqual({
      kind: 'card',
      title: 'Kilo Pass',
      description: "Kilo Pass isn't available in the app.",
      accessibilityLabel: "Kilo Pass. Kilo Pass isn't available in the app.",
    });
  });

  it('summarizes an active pass with its plan and status', () => {
    expect(
      getKiloPassCardContentState({
        subscription: subscription(),
        isError: false,
        isPending: false,
      })
    ).toEqual({
      kind: 'card',
      title: 'Kilo Pass',
      description: 'Active',
      accessibilityLabel: 'Kilo Pass. Active',
    });
  });
});
