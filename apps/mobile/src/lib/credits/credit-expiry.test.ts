import { describe, expect, it } from 'vitest';

import { getNextCreditExpiry } from './credit-expiry';

describe('getNextCreditExpiry', () => {
  it('shows only the next positive expiring cohort, not every dated balance', () => {
    expect(
      getNextCreditExpiry([
        { balance_mUsd: 900_000_000, expiry_date: null },
        { balance_mUsd: 50_000_000, expiry_date: '2028-10-15T00:00:00Z' },
        { balance_mUsd: 10_000_000, expiry_date: '2027-10-15T00:00:00Z' },
        { balance_mUsd: 5_000_000, expiry_date: '2027-10-15 00:00:00+00' },
        { balance_mUsd: 0, expiry_date: '2026-10-15T00:00:00Z' },
        { balance_mUsd: -1_000_000, expiry_date: '2026-10-15T00:00:00Z' },
      ])
    ).toEqual({
      balanceMicrodollars: 15_000_000,
      expiryDate: '2027-10-15T00:00:00Z',
      timestamp: Date.parse('2027-10-15T00:00:00Z'),
    });
  });

  it('does not invent expiry for Apple or grandfathered balances', () => {
    expect(getNextCreditExpiry([{ balance_mUsd: 100_000_000, expiry_date: null }])).toBeUndefined();
    expect(getNextCreditExpiry([])).toBeUndefined();
  });
});
