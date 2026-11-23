import { describe, expect, it, vi } from 'vitest';

import {
  buildCreditHistoryItems,
  type CreditDeduction,
  type CreditGrant,
  creditGrantKind,
  creditPurchaseChannel,
  type CreditPurchaseEntry,
} from './credit-history';

function purchase(overrides: Partial<CreditPurchaseEntry>): CreditPurchaseEntry {
  return {
    id: 'purchase-1',
    date: '2026-02-01T00:00:00.000Z',
    kind: 'purchase',
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
    expiry: null,
    reason: null,
    planName: null,
    purchase: null,
    ...overrides,
  };
}

function creditGrant(overrides: Partial<CreditGrant>): CreditGrant {
  return {
    id: 'grant-1',
    date: '2026-02-03T00:00:00.000Z',
    amount_mUsd: 5_000_000,
    kind: 'welcome',
    expiryDate: null,
    ...overrides,
  };
}

/** The paid grant a listed purchase row paints, as a ledger row reports it. */
function listedGrant(
  overrides: Partial<NonNullable<CreditDeduction['purchase']>> = {}
): NonNullable<CreditDeduction['purchase']> {
  return {
    id: 'p1',
    date: '2026-01-01T00:00:00.000Z',
    description: 'Top-up via stripe',
    amount_mUsd: 20_000_000,
    is_free: false,
    credit_source: 'stripe',
    kind: 'promotional',
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
      [deduction({ id: 'd1', date: '2026-02-10T00:00:00.000Z' })],
      []
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
            kind: 'promotional',
          },
        }),
      ],
      []
    );

    expect(items.map(item => item.key)).toEqual(['purchase:p2', 'ledger:expiry']);
  });

  it('keeps a stable order for two rows on the same timestamp', () => {
    const items = buildCreditHistoryItems(
      [purchase({ id: 'b', date: '2026-01-01T00:00:00.000Z' })],
      [deduction({ id: 'a', date: '2026-01-01T00:00:00.000Z' })],
      []
    );

    expect(items.map(item => item.key)).toEqual(['ledger:a', 'purchase:b']);
  });

  it('keeps the key order for an expiry whose grant is not listed', () => {
    // A grant the purchase pages do not hold has no row to fold into, so its
    // expiry stays a row of its own and keeps the key order it always had.
    const items = buildCreditHistoryItems(
      [purchase({ id: 'b', date: '2026-01-01T00:00:00.000Z' })],
      [
        deduction({
          id: 'a',
          date: '2026-01-01T00:00:00.000Z',
          kind: 'adjustment',
          purchase: {
            id: 'free-grant',
            date: '2026-01-01T00:00:00.000Z',
            description: 'Welcome credits',
            amount_mUsd: 5_000_000,
            is_free: true,
            credit_source: null,
            kind: 'welcome',
          },
        }),
      ],
      []
    );

    expect(items.map(item => item.key)).toEqual(['ledger:a', 'purchase:b']);
  });

  it('returns nothing for an account with no history', () => {
    expect(buildCreditHistoryItems([], [], [])).toEqual([]);
  });

  it('ranks the ledger by the PostgreSQL time the device cannot parse', () => {
    // Hermes rejects the server's `created_at` form, so the order cannot come
    // from `Date.parse`; every such row used to rank at epoch 0.
    const parseSpy = vi.spyOn(Date, 'parse').mockReturnValue(Number.NaN);
    try {
      const items = buildCreditHistoryItems(
        [purchase({ id: 'p1', date: '2026-03-16T15:40:00.000Z' })],
        [deduction({ id: 'd1', date: '2026-03-16 15:21:40.957+00' })],
        []
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
      ],
      []
    );

    expect(items.map(item => item.key)).toEqual(['ledger:dated', 'ledger:broken']);
  });

  it('folds a listed grant status row into its purchase row', () => {
    const items = buildCreditHistoryItems(
      [purchase({ id: 'p1', date: '2026-01-01T00:00:00.000Z' })],
      [
        deduction({
          id: 'expiry',
          date: '2026-04-01T00:00:00.000Z',
          kind: 'adjustment',
          expiry: 'expired',
          purchase: listedGrant(),
        }),
      ],
      []
    );

    // The status belongs to the purchase row's own block, so the ledger paints
    // no second row for it and the pair cannot drift apart.
    expect(items.map(item => item.key)).toEqual(['purchase:p1']);
    expect(items[0]).toMatchObject({ kind: 'purchase', status: { id: 'expiry' } });
  });

  it('keeps the first status row and lists the second close of one grant', () => {
    const items = buildCreditHistoryItems(
      [purchase({ id: 'p1', date: '2026-01-01T00:00:00.000Z' })],
      [
        deduction({
          id: 'expiry',
          date: '2026-04-01T00:00:00.000Z',
          kind: 'adjustment',
          expiry: 'expired',
          purchase: listedGrant(),
        }),
        deduction({
          id: 'voided',
          date: '2026-05-01T00:00:00.000Z',
          kind: 'adjustment',
          expiry: 'voided',
          purchase: listedGrant(),
        }),
      ],
      []
    );

    // One block can paint one status line, so the second row of the same grant
    // stays a row of its own below the purchase rather than disappearing.
    expect(items.map(item => item.key)).toEqual(['purchase:p1', 'ledger:voided']);
    expect(items.find(item => item.kind === 'purchase')).toMatchObject({
      status: { id: 'expiry' },
    });
  });

  it('keeps a charge against a listed grant as its own row', () => {
    // A spend row names the grant it drew on but records no expiry: it is an
    // event of its own, so folding it into the purchase block would paint it
    // nowhere at all.
    const items = buildCreditHistoryItems(
      [purchase({ id: 'p1', date: '2026-01-01T00:00:00.000Z' })],
      [
        deduction({
          id: 'spend',
          date: '2026-04-01T00:00:00.000Z',
          description: 'Deducting credits',
          expiry: null,
          purchase: listedGrant({ kind: 'adjustment' }),
        }),
      ],
      []
    );

    // The charge keeps its own row, flagged so the row states the event alone
    // instead of repeating the grant the purchase above already paints, and it
    // follows that purchase at the instant the two share.
    expect(items.map(item => item.key)).toEqual(['purchase:p1', 'ledger:spend']);
    expect(items.find(item => item.kind === 'purchase')).toMatchObject({ status: null });
    expect(items.find(item => item.kind === 'ledger')).toMatchObject({ grantListed: true });
  });

  it('keeps the grant line while its purchase page is not loaded', () => {
    const items = buildCreditHistoryItems(
      [],
      [
        deduction({
          id: 'expiry',
          date: '2026-04-01T00:00:00.000Z',
          kind: 'adjustment',
          purchase: listedGrant(),
        }),
      ],
      []
    );

    // Nothing can print the grant's purchase row, so the ledger row has to
    // carry the grant itself; the item carries no purchase-only field.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'ledger', deduction: { id: 'expiry' } });
  });

  it('lists the grant that funds a balance with no purchases', () => {
    const items = buildCreditHistoryItems([], [], [creditGrant({ id: 'welcome' })]);

    expect(items).toEqual([
      {
        kind: 'grant',
        key: 'grant:welcome',
        grant: creditGrant({ id: 'welcome' }),
        sortDate: '2026-02-03T00:00:00.000Z',
      },
    ]);
  });

  it('does not list a grant a loaded deduction already prints', () => {
    const items = buildCreditHistoryItems(
      [],
      [
        deduction({
          id: 'expiry',
          date: '2026-06-01T00:00:00.000Z',
          kind: 'adjustment',
          purchase: {
            id: 'welcome',
            date: '2026-02-03T00:00:00.000Z',
            description: 'Welcome credits',
            amount_mUsd: 5_000_000,
            is_free: true,
            credit_source: null,
            kind: 'welcome',
          },
        }),
      ],
      [creditGrant({ id: 'welcome' })]
    );

    expect(items.map(item => item.key)).toEqual(['ledger:expiry']);
  });

  it('interleaves purchases, grants, and deductions newest first', () => {
    const items = buildCreditHistoryItems(
      [purchase({ id: 'p1', date: '2026-01-10T00:00:00.000Z' })],
      [deduction({ id: 'd1', date: '2026-04-10T00:00:00.000Z' })],
      [creditGrant({ id: 'g1', date: '2026-03-10T00:00:00.000Z' })]
    );

    expect(items.map(item => item.key)).toEqual(['ledger:d1', 'grant:g1', 'purchase:p1']);
  });
});
