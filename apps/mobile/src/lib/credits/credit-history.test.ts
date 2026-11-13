import { describe, expect, it, vi } from 'vitest';

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

  it('ranks the ledger by the PostgreSQL time the device cannot parse', () => {
    // Hermes rejects the server's `created_at` form, so the order cannot come
    // from `Date.parse`; every such row used to rank at epoch 0.
    const parseSpy = vi.spyOn(Date, 'parse').mockReturnValue(Number.NaN);
    try {
      const items = buildCreditHistoryItems(
        [purchase({ id: 'p1', date: '2026-03-16T15:40:00.000Z' })],
        [deduction({ id: 'd1', date: '2026-03-16 15:21:40.957+00' })]
      );

      expect(items.map(item => item.key)).toEqual(['purchase:p1', 'ledger:d1']);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('sorts a row whose time does not parse below every dated row', () => {
    const items = buildCreditHistoryItems(
      [],
      [
        deduction({ id: 'broken', date: 'not a time' }),
        deduction({ id: 'dated', date: '2026-02-02 00:00:00+00' }),
      ]
    );

    expect(items.map(item => item.key)).toEqual(['ledger:dated', 'ledger:broken']);
  });

  it('marks a ledger row whose grant already has its purchase row', () => {
    const items = buildCreditHistoryItems(
      [purchase({ id: 'p1', date: '2026-01-01T00:00:00.000Z' })],
      [
        deduction({
          id: 'expiry',
          date: '2026-04-01T00:00:00.000Z',
          kind: 'adjustment',
          purchase: {
            id: 'p1',
            date: '2026-01-01T00:00:00.000Z',
            description: 'Top-up via stripe',
            amount_mUsd: 20_000_000,
            is_free: false,
            credit_source: 'stripe',
          },
        }),
      ]
    );

    const ledger = items.find(item => item.key === 'ledger:expiry');
    expect(ledger).toMatchObject({ kind: 'ledger', grantListed: true });
  });

  it('keeps the grant line while its purchase page is not loaded', () => {
    const items = buildCreditHistoryItems(
      [],
      [
        deduction({
          id: 'expiry',
          date: '2026-04-01T00:00:00.000Z',
          kind: 'adjustment',
          purchase: {
            id: 'p1',
            date: '2026-01-01T00:00:00.000Z',
            description: 'Top-up via stripe',
            amount_mUsd: 20_000_000,
            is_free: false,
            credit_source: 'stripe',
          },
        }),
      ]
    );

    const ledger = items.find(item => item.key === 'ledger:expiry');
    expect(ledger).toMatchObject({ kind: 'ledger', grantListed: false });
  });
});
