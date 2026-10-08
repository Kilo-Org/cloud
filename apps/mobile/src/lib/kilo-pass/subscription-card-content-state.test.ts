import { describe, expect, it, vi } from 'vitest';
import {
  getKiloPassPaidThrough,
  getKiloPassStatusTitle,
  getKiloPassSubscriptionCardContentState,
  type KiloPassSubscription,
} from './subscription-card-state';
vi.mock('@/lib/hooks/use-language-preference', () => ({ getResolvedLanguage: () => 'en' }));
const active: KiloPassSubscription = {
  subscriptionId: 'legacy',
  stripeSubscriptionId: null,
  paymentProvider: 'app_store',
  providerSubscriptionId: 'legacy-original',
  tier: 'tier_19' as KiloPassSubscription['tier'],
  cadence: 'monthly',
  status: 'active',
  cancelAtPeriodEnd: false,
  currentStreakMonths: 4,
  nextYearlyIssueAt: null,
  startedAt: '2026-07-08T12:00:00.000Z',
  resumesAt: null,
  nextBonusCreditsUsd: null,
  nextBillingAt: '2026-11-08T12:00:00.000Z',
  isFirstTimeSubscriberEver: false,
  currentPeriodBaseCreditsUsd: 19,
  currentPeriodUsageUsd: 0,
  currentPeriodHostingCostUsd: 0,
  currentPeriodBonusCreditsUsd: null,
  currentPeriodBonus: {
    status: 'available',
    kind: null,
    actualAmountUsd: null,
    projectedAmountUsd: null,
  },
  isBonusUnlocked: false,
  isBonusAvailableToUnlock: false,
  refillAt: '2026-10-09T12:00:00.000Z',
};
function content(subscription: KiloPassSubscription | null) {
  return getKiloPassSubscriptionCardContentState({
    subscription,
    stateIsError: false,
    stateIsPending: false,
  });
}
describe('sales-free subscription card', () => {
  it('handles pending and error status independently of purchase presentation', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        subscription: null,
        stateIsPending: true,
        stateIsError: false,
      })
    ).toEqual({ kind: 'loading' });
    expect(
      getKiloPassSubscriptionCardContentState({
        subscription: null,
        stateIsPending: false,
        stateIsError: true,
      })
    ).toMatchObject({ kind: 'error', actionLabel: 'Retry' });
  });
  it('opens status, not sales, for an account without a subscription', () => {
    expect(content(null)).toMatchObject({
      kind: 'card',
      state: { action: 'open-native', actionLabel: 'Details', description: 'Not subscribed' },
    });
  });
  it.each(['stripe', 'app_store', 'google_play'] as const)(
    'opens the same read-only status for %s subscribers',
    paymentProvider => {
      expect(content({ ...active, paymentProvider })).toMatchObject({
        kind: 'card',
        state: { action: 'open-native', actionLabel: 'Details', title: 'Kilo Pass active' },
      });
    }
  );
  it('keeps paid-period end visible before scheduled cancellation', () => {
    expect(content({ ...active, cancelAtPeriodEnd: true })).toMatchObject({
      kind: 'card',
      state: {
        title: 'Kilo Pass canceling',
        description: expect.stringContaining('Paid benefits through'),
      },
    });
  });
  it.each(['canceled', 'incomplete_expired'] as const)(
    'does not call an ended %s subscription active',
    status => {
      expect(getKiloPassStatusTitle({ ...active, status })).toBe('Ended');
      expect(getKiloPassPaidThrough({ ...active, status, nextBillingAt: null })).toBe(null);
    }
  );
  it.each(['incomplete', 'past_due', 'unpaid', 'paused'] as const)(
    'does not call %s active',
    status => {
      expect(getKiloPassStatusTitle({ ...active, status })).not.toBe('Kilo Pass active');
    }
  );
  it('does not fabricate a missing or invalid paid expiry', () => {
    expect(getKiloPassPaidThrough({ ...active, nextBillingAt: null })).toBe(null);
    expect(getKiloPassPaidThrough({ ...active, nextBillingAt: 'invalid' })).toBe(null);
  });
});
