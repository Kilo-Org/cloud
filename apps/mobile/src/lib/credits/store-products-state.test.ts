import { describe, expect, it } from 'vitest';

import {
  type BackendStoreCreditProduct,
  getStoreCreditProductsState,
  type StoreCreditProduct,
} from './store-products';

const backendProduct: BackendStoreCreditProduct = {
  amountUsd: 10,
  appleProductId: 'credits.usd10.v1',
  googleProductId: 'credits_usd10',
};

const pricedProducts: StoreCreditProduct[] = [
  { backend: backendProduct, storeProductId: 'credits.usd10.v1', displayPrice: '$10.99' },
];

const unpricedProducts: StoreCreditProduct[] = [
  { backend: backendProduct, storeProductId: null, displayPrice: null },
  {
    backend: {
      amountUsd: 50,
      appleProductId: 'credits.usd50.v1',
      googleProductId: 'credits_usd50',
    },
    storeProductId: null,
    displayPrice: null,
  },
];

describe('getStoreCreditProductsState', () => {
  it('lets a store error win over query data and marks the store unavailable', () => {
    expect(
      getStoreCreditProductsState({
        data: pricedProducts,
        isError: false,
        storeErrorMessage: 'kiloPass.couldNotConnectToAppStore',
        queryErrorMessage: null,
      })
    ).toEqual({
      products: [],
      isError: true,
      errorMessageKey: 'kiloPass.couldNotConnectToAppStore',
      storeUnavailable: true,
    });
  });

  it('keeps the packs but marks the store unavailable when no pack has a store price', () => {
    expect(
      getStoreCreditProductsState({
        data: unpricedProducts,
        isError: false,
        storeErrorMessage: null,
        queryErrorMessage: null,
      })
    ).toEqual({
      products: unpricedProducts,
      isError: false,
      errorMessageKey: null,
      storeUnavailable: true,
    });
  });

  it('sets neither error nor store-unavailable for a healthy answer', () => {
    expect(
      getStoreCreditProductsState({
        data: pricedProducts,
        isError: false,
        storeErrorMessage: null,
        queryErrorMessage: null,
      })
    ).toEqual({
      products: pricedProducts,
      isError: false,
      errorMessageKey: null,
      storeUnavailable: false,
    });
  });

  it('surfaces the loader key and marks the store unavailable when the store fetch failed', () => {
    expect(
      getStoreCreditProductsState({
        data: undefined,
        isError: true,
        storeErrorMessage: null,
        queryErrorMessage: 'credits.noMatchingProducts',
      })
    ).toEqual({
      products: [],
      isError: true,
      errorMessageKey: 'credits.noMatchingProducts',
      storeUnavailable: true,
    });
  });

  it('is neither an error nor store-unavailable while the query is still loading', () => {
    expect(
      getStoreCreditProductsState({
        data: undefined,
        isError: false,
        storeErrorMessage: null,
        queryErrorMessage: null,
      })
    ).toEqual({
      products: [],
      isError: false,
      errorMessageKey: null,
      storeUnavailable: false,
    });
  });
});
