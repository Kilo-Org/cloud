import { getExpiringCreditGroups } from './getExpiringCreditGroups';

describe('getExpiringCreditGroups', () => {
  it('keeps remaining balances separate when their expiration dates differ', () => {
    expect(
      getExpiringCreditGroups([
        { expiry_date: '2031-04-01T00:00:00Z', balance_mUsd: 90_000_000 },
        { expiry_date: '2030-05-01T00:00:00Z', balance_mUsd: 4_000_000 },
      ])
    ).toEqual([
      { expiry_date: '2030-05-01T00:00:00.000Z', balance_mUsd: 4_000_000 },
      { expiry_date: '2031-04-01T00:00:00.000Z', balance_mUsd: 90_000_000 },
    ]);
  });

  it('combines balances for the same expiration instant across timestamp formats', () => {
    expect(
      getExpiringCreditGroups([
        { expiry_date: '2030-05-01 00:00:00+00', balance_mUsd: 7_000_000 },
        { expiry_date: '2030-04-30T20:00:00-04:00', balance_mUsd: 2_000_000 },
      ])
    ).toEqual([{ expiry_date: '2030-05-01T00:00:00.000Z', balance_mUsd: 9_000_000 }]);
  });

  it('excludes non-expiring and exhausted balances', () => {
    expect(
      getExpiringCreditGroups([
        { expiry_date: null, balance_mUsd: 20_000_000 },
        { expiry_date: '2030-05-01T00:00:00Z', balance_mUsd: 0 },
        { expiry_date: '2030-05-01T00:00:00Z', balance_mUsd: -1_000_000 },
        { expiry_date: '2030-06-01T00:00:00Z', balance_mUsd: 3_000_000 },
      ])
    ).toEqual([{ expiry_date: '2030-06-01T00:00:00.000Z', balance_mUsd: 3_000_000 }]);
  });
});
