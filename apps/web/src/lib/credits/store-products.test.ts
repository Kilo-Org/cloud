import { describe, expect, it } from '@jest/globals';

import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';

import {
  STORE_CREDIT_PRODUCTS,
  getStoreCreditProductByAppleProductId,
  getStoreCreditProductByGoogleProductId,
  storeCreditPaymentId,
} from './store-products';

describe('STORE_CREDIT_PRODUCTS', () => {
  it('lists exactly the four preset packs in order', () => {
    expect(STORE_CREDIT_PRODUCTS.map(product => product.amountUsd)).toEqual([10, 50, 100, 500]);
    expect(STORE_CREDIT_PRODUCTS.map(product => product.appleProductId)).toEqual([
      'credits.usd10.v1',
      'credits.usd50.v1',
      'credits.usd100.v1',
      'credits.usd500.v1',
    ]);
    expect(STORE_CREDIT_PRODUCTS.map(product => product.googleProductId)).toEqual([
      'credits_usd10',
      'credits_usd50',
      'credits_usd100',
      'credits_usd500',
    ]);
  });

  it('derives each pack amount in microdollars from its USD amount', () => {
    expect(STORE_CREDIT_PRODUCTS.map(product => product.amountMicrodollars)).toEqual([
      10_000_000, 50_000_000, 100_000_000, 500_000_000,
    ]);
  });
});

describe('store credit product lookups', () => {
  it('finds a pack by its Apple product id', () => {
    expect(getStoreCreditProductByAppleProductId('credits.usd100.v1')).toMatchObject({
      amountUsd: 100,
      amountMicrodollars: 100_000_000,
      googleProductId: 'credits_usd100',
    });
  });

  it('finds a pack by its Google product id', () => {
    expect(getStoreCreditProductByGoogleProductId('credits_usd500')).toMatchObject({
      amountUsd: 500,
      amountMicrodollars: 500_000_000,
      appleProductId: 'credits.usd500.v1',
    });
  });

  it('returns undefined for an unknown id', () => {
    expect(getStoreCreditProductByAppleProductId('unknown')).toBeUndefined();
    expect(getStoreCreditProductByGoogleProductId('unknown')).toBeUndefined();
  });
});

describe('storeCreditPaymentId', () => {
  it('builds the store-scoped idempotency key', () => {
    expect(storeCreditPaymentId(KiloPassPaymentProvider.AppStore, 'tx-1')).toBe(
      'store-credit:app_store:tx-1'
    );
    expect(storeCreditPaymentId(KiloPassPaymentProvider.GooglePlay, 'GPA.1234')).toBe(
      'store-credit:google_play:GPA.1234'
    );
  });
});
