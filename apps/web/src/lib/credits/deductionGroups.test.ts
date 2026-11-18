import { buildDeductionGroups, type CreditDeductionRow } from './deductionGroups';

function makeDeduction(overrides: Partial<CreditDeductionRow> = {}): CreditDeductionRow {
  return {
    id: 'deduction-1',
    date: '2026-10-01T00:00:00.000Z',
    description: 'Expired: Promotional credits',
    amount_mUsd: -50_000_000,
    kind: 'adjustment',
    purchase: {
      id: 'grant-1',
      date: '2025-10-01T00:00:00.000Z',
      description: 'Promotional credits',
      amount_mUsd: 50_000_000,
      is_free: false,
      credit_source: 'stripe',
    },
    ...overrides,
  };
}

describe('buildDeductionGroups', () => {
  it('leads a paired group with the purchase and keeps the expiry as its child line', () => {
    const groups = buildDeductionGroups([makeDeduction()]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({
      key: 'deduction-1',
      main: {
        date: '2025-10-01T00:00:00.000Z',
        description: 'Promotional credits',
        type: 'Purchase',
        amount_mUsd: 50_000_000,
      },
      child: {
        description: 'Expired: Promotional credits',
        type: 'Adjustment',
        amount_mUsd: -50_000_000,
      },
    });
  });

  it('labels an uncharged grant as a credit grant, not a purchase', () => {
    const groups = buildDeductionGroups([
      makeDeduction({
        purchase: {
          id: 'grant-free',
          date: '2025-10-01T00:00:00.000Z',
          description: 'Referral bonus',
          amount_mUsd: 5_000_000,
          is_free: true,
          credit_source: null,
        },
        amount_mUsd: -5_000_000,
      }),
    ]);

    expect(groups[0].main.type).toBe('Credit grant');
    expect(groups[0].child?.type).toBe('Adjustment');
  });

  it.each([
    { source: 'stripe', isFree: false, label: 'Purchase' },
    { source: 'google_play', isFree: false, label: 'Purchase' },
    { source: 'apple', isFree: false, label: 'Purchase' },
    { source: 'pass', isFree: false, label: 'Kilo Pass' },
    { source: 'admin', isFree: false, label: 'Credit grant' },
    { source: 'admin', isFree: true, label: 'Credit grant' },
    // A legacy paid grant carries no source; its free flag still decides.
    { source: null, isFree: false, label: 'Purchase' },
    { source: null, isFree: true, label: 'Credit grant' },
  ])('labels a $source grant as $label', ({ source, isFree, label }) => {
    const groups = buildDeductionGroups([
      makeDeduction({
        purchase: {
          id: 'grant-source',
          date: '2025-10-01T00:00:00.000Z',
          description: 'Expiring credits',
          amount_mUsd: 5_000_000,
          is_free: isFree,
          credit_source: source,
        },
        amount_mUsd: -5_000_000,
      }),
    ]);

    expect(groups[0].main.type).toBe(label);
  });

  it('leaves an unlinked deduction as a single row in its own date order', () => {
    const groups = buildDeductionGroups([
      makeDeduction({
        id: 'legacy',
        date: '2026-10-05T00:00:00.000Z',
        description: 'Deducting credits, due to expiration time.',
        amount_mUsd: -3_000_000,
        kind: 'deduction',
        purchase: null,
      }),
    ]);

    expect(groups).toEqual([
      {
        key: 'legacy',
        main: {
          date: '2026-10-05T00:00:00.000Z',
          description: 'Deducting credits, due to expiration time.',
          type: 'Deduction',
          amount_mUsd: -3_000_000,
        },
      },
    ]);
  });

  it('orders groups by the date the row shows, newest first', () => {
    const groups = buildDeductionGroups([
      makeDeduction({
        id: 'older-pair',
        purchase: {
          id: 'grant-older',
          date: '2025-01-01T00:00:00.000Z',
          description: 'Older credits',
          amount_mUsd: 10_000_000,
          is_free: false,
          credit_source: 'stripe',
        },
      }),
      makeDeduction({
        id: 'newer-deduction',
        date: '2026-11-01T00:00:00.000Z',
        description: 'Usage charge',
        amount_mUsd: -1_000_000,
        kind: 'deduction',
        purchase: null,
      }),
    ]);

    expect(groups.map(group => group.key)).toEqual(['newer-deduction', 'older-pair']);
  });
});
