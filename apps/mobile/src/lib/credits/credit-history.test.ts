import { describe, expect, it } from 'vitest';

import {
  buildCreditHistoryItems,
  type CreditDeduction,
  creditGrantKind,
  creditPurchaseChannel,
  type CreditPurchaseEntry,
} from './credit-history';

function purchase(overrides: Partial<CreditPurchaseEntry>): CreditPurchaseEntry {
  return {
    id: 'purchase-1',
    date: '2026-02-01T00:00:00.000Z',
    description: 'Credit purchase',
    amount_mUsd: 20_000_000,
    expiryDate: null,
    creditSource: 'stripe',
    ...overrides,
  };
}

function deduction(overrides: Partial<CreditDeduction>): CreditDeduction {
  return {
    id: 'deduction-1',
    date: '2026-02-02T00:00:00.000Z',
    description: 'Usage',
    amount_mUsd: -1_000_000,
    kind: 'deduction',
    purchase: null,
    ...overrides,
  };
}

describe('creditPurchaseChannel', () => {
  it.each([
    ['apple', 'app_store'],
    ['google_play', 'google_play'],
    ['stripe', 'card'],
    // A legacy top-up recorded before the column existed is still a card
    // purchase; the receipt lookup decides whether a receipt exists.
    [null, 'card'],
    ['pass', 'other'],
    ['admin', 'other'],
  ] as const)('maps %s to %s', (source, expected) => {
    expect(creditPurchaseChannel(source)).toBe(expected);
  });
});

describe('creditGrantKind', () => {
  it.each([
    [{ creditSource: 'stripe', isFree: false }, 'purchase'],
    [{ creditSource: 'apple', isFree: false }, 'purchase'],
    [{ creditSource: 'google_play', isFree: false }, 'purchase'],
    [{ creditSource: 'pass', isFree: false }, 'pass'],
    [{ creditSource: 'admin', isFree: false }, 'grant'],
    [{ creditSource: null, isFree: true }, 'grant'],
    [{ creditSource: null, isFree: false }, 'purchase'],
  ] as const)('labels %o as %s', (grant, expected) => {
    expect(creditGrantKind(grant)).toBe(expected);
  });
});

describe('buildCreditHistoryItems', () => {
  it('merges purchases and ledger rows newest first', () => {
    const items = buildCreditHistoryItems(
      [purchase({ id: 'p1', date: '2026-01-10T00:00:00.000Z' })],
      [deduction({ id: 'd1', date: '2026-02-10T00:00:00.000Z' })]
    );

    expect(items.map(item => item.key)).toEqual(['ledger:d1', 'purchase:p1']);
  });

  it('sorts an expiry under the grant it closed, not under the expiry date', () => {
    const items = buildCreditHistoryItems(
      [purchase({ id: 'p2', date: '2026-03-01T00:00:00.000Z' })],
      [
        deduction({
          id: 'expiry',
          date: '2026-06-01T00:00:00.000Z',
          kind: 'adjustment',
          purchase: {
            id: 'p1',
            date: '2026-01-01T00:00:00.000Z',
            description: 'Credit purchase',
            amount_mUsd: 20_000_000,
            is_free: false,
            credit_source: 'stripe',
          },
        }),
      ]
    );

    expect(items.map(item => item.key)).toEqual(['purchase:p2', 'ledger:expiry']);
  });

  it('keeps a stable order for two rows on the same timestamp', () => {
    const items = buildCreditHistoryItems(
      [purchase({ id: 'b', date: '2026-01-01T00:00:00.000Z' })],
      [deduction({ id: 'a', date: '2026-01-01T00:00:00.000Z' })]
    );

    expect(items.map(item => item.key)).toEqual(['ledger:a', 'purchase:b']);
  });

  it('returns nothing for an account with no history', () => {
    expect(buildCreditHistoryItems([], [])).toEqual([]);
  });
});
