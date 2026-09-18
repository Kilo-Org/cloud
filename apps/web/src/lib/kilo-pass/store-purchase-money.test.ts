import { describe, expect, it } from '@jest/globals';
import type { androidpublisher_v3 } from '@googleapis/androidpublisher';

import {
  googlePlayMoneyToMinorUnits,
  googlePlayOrderMoneyForProduct,
  type StorePurchaseMoney,
} from './store-purchase-money';

const NO_MONEY: StorePurchaseMoney = {
  amountChargedMinorUnits: null,
  currency: null,
  taxMinorUnits: null,
};

function order(
  overrides: Partial<androidpublisher_v3.Schema$Order> = {}
): androidpublisher_v3.Schema$Order {
  return {
    orderId: 'GPA.1234',
    purchaseToken: 'play-token-1',
    state: 'PROCESSED',
    lineItems: [{ productId: 'kilopass_tier19' }],
    ...overrides,
  };
}

describe('googlePlayMoneyToMinorUnits', () => {
  it('converts whole units in a two-decimal currency', () => {
    expect(googlePlayMoneyToMinorUnits({ currencyCode: 'USD', units: '19', nanos: 0 })).toBe(1900);
  });

  it('adds the nanos part in a two-decimal currency', () => {
    expect(googlePlayMoneyToMinorUnits({ currencyCode: 'USD', units: '3', nanos: 170000000 })).toBe(
      317
    );
  });

  it('keeps a zero-decimal currency in whole units', () => {
    expect(googlePlayMoneyToMinorUnits({ currencyCode: 'JPY', units: '1900' })).toBe(1900);
    expect(googlePlayMoneyToMinorUnits({ currencyCode: 'KRW', units: '1200', nanos: 0 })).toBe(
      1200
    );
    expect(googlePlayMoneyToMinorUnits({ currencyCode: 'VND', units: '50000' })).toBe(50000);
  });

  it('converts a three-decimal currency', () => {
    expect(googlePlayMoneyToMinorUnits({ currencyCode: 'KWD', units: '1', nanos: 250000000 })).toBe(
      1250
    );
  });

  it('uses the ISO 4217 exponent, not the ICU display digits', () => {
    // ICU reports no decimals for HUF and IDR; ISO 4217 gives them two.
    // (TWD is two in both, and stays two.)
    expect(googlePlayMoneyToMinorUnits({ currencyCode: 'HUF', units: '1900', nanos: 0 })).toBe(
      190000
    );
    expect(googlePlayMoneyToMinorUnits({ currencyCode: 'IDR', units: '50000', nanos: 0 })).toBe(
      5000000
    );
    expect(googlePlayMoneyToMinorUnits({ currencyCode: 'TWD', units: '19', nanos: 0 })).toBe(1900);
  });

  it('treats an unknown but well-formed currency code as two-decimal', () => {
    expect(googlePlayMoneyToMinorUnits({ currencyCode: 'ZZZ', units: '19', nanos: 0 })).toBe(1900);
  });

  it('rounds a sub-minor-unit remainder instead of failing', () => {
    expect(googlePlayMoneyToMinorUnits({ currencyCode: 'USD', units: '1', nanos: 4990000 })).toBe(
      100
    );
    expect(googlePlayMoneyToMinorUnits({ currencyCode: 'USD', units: '1', nanos: 5000000 })).toBe(
      101
    );
  });

  it('keeps the PostgreSQL integer maximum and drops anything above it', () => {
    // 2_147_483_647 minor units is the largest value the `integer` column takes.
    expect(
      googlePlayMoneyToMinorUnits({ currencyCode: 'USD', units: '21474836', nanos: 470000000 })
    ).toBe(2_147_483_647);
    // 3_000_000_000 would be rejected by the column and fail the whole insert,
    // so it is unusable money like any other.
    expect(
      googlePlayMoneyToMinorUnits({ currencyCode: 'USD', units: '30000000', nanos: 0 })
    ).toBeNull();
  });

  it.each([
    ['null money', null],
    ['undefined money', undefined],
    ['missing currencyCode', { units: '19', nanos: 0 }],
    ['lowercase currencyCode', { currencyCode: 'usd', units: '19', nanos: 0 }],
    ['non-ISO currencyCode', { currencyCode: 'US', units: '19', nanos: 0 }],
    ['non-numeric units', { currencyCode: 'USD', units: 'not-a-number', nanos: 0 }],
    ['non-numeric nanos', { currencyCode: 'USD', units: '19', nanos: Number.NaN }],
    ['negative units', { currencyCode: 'USD', units: '-19', nanos: 0 }],
    ['negative nanos', { currencyCode: 'USD', units: '0', nanos: -100000000 }],
    ['negative units and nanos', { currencyCode: 'USD', units: '-1', nanos: -500000000 }],
  ] as const)('returns null for %s', (_label, money) => {
    expect(() =>
      googlePlayMoneyToMinorUnits(money as androidpublisher_v3.Schema$Money)
    ).not.toThrow();
    expect(googlePlayMoneyToMinorUnits(money as androidpublisher_v3.Schema$Money)).toBeNull();
  });
});

describe('googlePlayOrderMoneyForProduct', () => {
  it('uses the matched line item money', () => {
    const result = googlePlayOrderMoneyForProduct(
      order({
        total: { currencyCode: 'USD', units: '99', nanos: 0 },
        tax: { currencyCode: 'USD', units: '9', nanos: 90000000 },
        lineItems: [
          {
            productId: 'kilopass_tier49',
            total: { currencyCode: 'USD', units: '49', nanos: 0 },
            tax: { currencyCode: 'USD', units: '4', nanos: 90000000 },
          },
          {
            productId: 'kilopass_tier19',
            total: { currencyCode: 'USD', units: '19', nanos: 0 },
            tax: { currencyCode: 'USD', units: '3', nanos: 170000000 },
          },
        ],
      }),
      'kilopass_tier19'
    );

    expect(result).toEqual({ amountChargedMinorUnits: 1900, currency: 'USD', taxMinorUnits: 317 });
  });

  it('falls back to the only line item when no product matches', () => {
    const result = googlePlayOrderMoneyForProduct(
      order({
        lineItems: [
          {
            productId: 'kilopass.tier19.monthly.v1',
            total: { currencyCode: 'EUR', units: '19', nanos: 0 },
            tax: { currencyCode: 'EUR', units: '3', nanos: 170000000 },
          },
        ],
      }),
      'kilopass_tier19'
    );

    expect(result).toEqual({ amountChargedMinorUnits: 1900, currency: 'EUR', taxMinorUnits: 317 });
  });

  it('falls back to the order totals when the only item carries no money', () => {
    const result = googlePlayOrderMoneyForProduct(
      order({
        total: { currencyCode: 'USD', units: '19', nanos: 0 },
        tax: { currencyCode: 'USD', units: '3', nanos: 170000000 },
        lineItems: [{ productId: 'kilopass_tier19' }],
      }),
      'kilopass_tier19'
    );

    expect(result).toEqual({ amountChargedMinorUnits: 1900, currency: 'USD', taxMinorUnits: 317 });
  });

  it('does not lend the order totals to one product of a multi-item order', () => {
    const result = googlePlayOrderMoneyForProduct(
      order({
        total: { currencyCode: 'USD', units: '68', nanos: 0 },
        tax: { currencyCode: 'USD', units: '6', nanos: 0 },
        lineItems: [
          { productId: 'kilopass_tier19' },
          {
            productId: 'kilopass_tier49',
            total: { currencyCode: 'USD', units: '49', nanos: 0 },
            tax: { currencyCode: 'USD', units: '4', nanos: 0 },
          },
        ],
      }),
      'kilopass_tier19'
    );

    expect(result).toEqual(NO_MONEY);
  });

  it('takes the currency from the tax when only tax is interpretable', () => {
    const result = googlePlayOrderMoneyForProduct(
      order({
        lineItems: [
          {
            productId: 'kilopass_tier19',
            tax: { currencyCode: 'GBP', units: '3', nanos: 170000000 },
          },
        ],
      }),
      'kilopass_tier19'
    );

    expect(result).toEqual({ amountChargedMinorUnits: null, currency: 'GBP', taxMinorUnits: 317 });
  });

  it('treats a negative item amount as no money instead of rejecting the purchase', () => {
    const result = googlePlayOrderMoneyForProduct(
      order({
        lineItems: [
          {
            productId: 'kilopass_tier19',
            total: { currencyCode: 'USD', units: '-19', nanos: 0 },
          },
        ],
      }),
      'kilopass_tier19'
    );

    expect(result).toEqual(NO_MONEY);
  });

  it('drops only a negative tax and keeps the amount', () => {
    const result = googlePlayOrderMoneyForProduct(
      order({
        lineItems: [
          {
            productId: 'kilopass_tier19',
            total: { currencyCode: 'USD', units: '19', nanos: 0 },
            tax: { currencyCode: 'USD', units: '-3', nanos: -170000000 },
          },
        ],
      }),
      'kilopass_tier19'
    );

    expect(result).toEqual({ amountChargedMinorUnits: 1900, currency: 'USD', taxMinorUnits: null });
  });

  it.each([
    [
      'an uninterpretable item total',
      order({
        total: { currencyCode: 'USD', units: '19', nanos: 0 },
        lineItems: [{ productId: 'kilopass_tier19', total: { units: '19', nanos: 0 } }],
      }),
    ],
    ['an order with no money', order()],
    [
      'an uninterpretable order total with no item money',
      order({ total: { currencyCode: 'usd', units: '19', nanos: 0 } }),
    ],
    [
      'an order whose only item is a different product',
      order({ lineItems: [{ productId: 'kilopass_tier49' }] }),
    ],
    [
      'multiple items none of which match the product',
      order({
        lineItems: [
          {
            productId: 'kilopass_tier49',
            total: { currencyCode: 'USD', units: '49', nanos: 0 },
          },
          {
            productId: 'kilopass_tier199',
            total: { currencyCode: 'USD', units: '199', nanos: 0 },
          },
        ],
      }),
    ],
  ] as const)('returns all nulls for %s without throwing', (_label, value) => {
    expect(() => googlePlayOrderMoneyForProduct(value, 'kilopass_tier19')).not.toThrow();
    expect(googlePlayOrderMoneyForProduct(value, 'kilopass_tier19')).toEqual(NO_MONEY);
  });
});
