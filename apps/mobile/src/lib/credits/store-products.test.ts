import { describe, expect, it } from 'vitest';

import { type BackendStoreCreditProduct, joinStoreCreditProducts } from './store-products';

const backendProducts: BackendStoreCreditProduct[] = [
  { amountUsd: 10, appleProductId: 'credits.usd10.v1', googleProductId: 'credits_usd10' },
  { amountUsd: 50, appleProductId: 'credits.usd50.v1', googleProductId: 'credits_usd50' },
  { amountUsd: 100, appleProductId: 'credits.usd100.v1', googleProductId: 'credits_usd100' },
  { amountUsd: 500, appleProductId: 'credits.usd500.v1', googleProductId: 'credits_usd500' },
];

describe('joinStoreCreditProducts', () => {
  it('keeps every backend pack in catalog order and prices the ones the store sells', () => {
    const products = joinStoreCreditProducts({
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      backendProducts,
      storefront: 'app_store',
      storeProducts: [
        { id: 'credits.usd10.v1', displayPrice: '$10.99' },
        { id: 'credits.usd500.v1', displayPrice: '$529.99' },
      ],
    });

    expect(products.map(product => product.backend.amountUsd)).toEqual([10, 50, 100, 500]);
    expect(products.map(product => product.displayPrice)).toEqual([
      '$10.99',
      null,
      null,
      '$529.99',
    ]);
    expect(products.map(product => product.storeProductId)).toEqual([
      'credits.usd10.v1',
      null,
      null,
      'credits.usd500.v1',
    ]);
  });

  it('matches App Store packs by the Apple product id', () => {
    const products = joinStoreCreditProducts({
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      backendProducts,
      storefront: 'app_store',
      storeProducts: [{ id: 'credits.usd50.v1', displayPrice: '$57.99' }],
    });

    expect(products[1]).toEqual({
      backend: backendProducts[1],
      storeProductId: 'credits.usd50.v1',
      displayPrice: '$57.99',
    });
    expect(products[0]?.displayPrice).toBeNull();
  });

  it('matches Play packs by the Google product id', () => {
    const products = joinStoreCreditProducts({
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      backendProducts,
      storefront: 'play',
      storeProducts: [{ id: 'credits_usd50', displayPrice: '€57.99' }],
    });

    expect(products[1]).toEqual({
      backend: backendProducts[1],
      storeProductId: 'credits_usd50',
      displayPrice: '€57.99',
    });
  });

  it('does not match an Apple product id on the Play storefront', () => {
    const products = joinStoreCreditProducts({
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      backendProducts,
      storefront: 'play',
      storeProducts: [{ id: 'credits.usd10.v1', displayPrice: '$10.99' }],
    });

    expect(products.every(product => product.displayPrice === null)).toBe(true);
  });

  it('returns no packs for an empty backend catalog', () => {
    expect(
      joinStoreCreditProducts({
        appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
        backendProducts: [],
        storefront: 'app_store',
        storeProducts: [{ id: 'credits.usd10.v1', displayPrice: '$10.99' }],
      })
    ).toEqual([]);
  });
});
