import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { getKiloPassCardContentState, type KiloPassSubscription } from './state';

function subscription(overrides: Partial<KiloPassSubscription> = {}): KiloPassSubscription {
  return {
    tier: 'tier_49',
    cadence: 'monthly',
    status: 'active',
    cancelAtPeriodEnd: false,
    resumesAt: null,
    endedAt: null,
    nextBillingAt: '2026-12-05T12:00:00.000Z',
    refillAt: '2026-12-05T12:00:00.000Z',
    currentPeriodBaseCreditsUsd: 49,
    currentPeriodUsageUsd: 12.5,
    currentPeriodBonus: {
      status: 'available',
      kind: null,
      actualAmountUsd: null,
      projectedAmountUsd: 9.8,
    },
    ...overrides,
  };
}

afterEach(async () => {
  await i18n.changeLanguage('en');
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
      description: 'Check your connection, then try again.',
      actionLabel: 'Retry',
      accessibilityLabel: "Couldn't load Kilo Pass. Check your connection, then try again. Retry",
    });
  });

  it('announces each error sentence with a single full stop', async () => {
    await i18n.changeLanguage('pt-BR');

    const state = getKiloPassCardContentState({
      subscription: undefined,
      isError: true,
      isPending: false,
    });

    if (state.kind !== 'error') {
      throw new Error(`unexpected state: ${state.kind}`);
    }
    expect(state.accessibilityLabel).toBe(
      'O Kilo Pass está indisponível. Verifique sua conexão e tente novamente. Tentar novamente'
    );
  });

  it('joins Thai sentences with the space the catalog writes between sentences', async () => {
    await i18n.changeLanguage('th');

    const state = getKiloPassCardContentState({
      subscription: undefined,
      isError: true,
      isPending: false,
    });

    if (state.kind !== 'error') {
      throw new Error(`unexpected state: ${state.kind}`);
    }
    const parts = [
      i18n.t('kiloPass.unavailable'),
      i18n.t('kiloPass.loadFailedRetry'),
      i18n.t('common.retry'),
    ];
    expect(state.accessibilityLabel).not.toContain('.');
    expect(state.accessibilityLabel).toBe(parts.join(' '));
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

  it('summarizes a lapsed pass with its tier and end date', () => {
    expect(
      getKiloPassCardContentState({
        subscription: subscription({ status: 'canceled', endedAt: '2026-11-08T04:05:06.000Z' }),
        isError: false,
        isPending: false,
      })
    ).toEqual({
      kind: 'card',
      title: 'Kilo Pass',
      description: 'Pro · Ended Nov 8, 2026',
      accessibilityLabel: 'Kilo Pass. Pro · Ended Nov 8, 2026',
    });
  });
});
