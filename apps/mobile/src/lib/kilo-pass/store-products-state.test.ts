import { describe, expect, it } from 'vitest';

import {
  getStoreKiloPassProductsState,
  isStoreKiloPassProductsLoading,
} from './store-products-state';
import { type AppStoreKiloPassProduct } from './store-products';

const products: AppStoreKiloPassProduct[] = [
  {
    tier: 'tier_19',
    cadence: 'monthly',
    appleProductId: 'kilopass.tier19.monthly.v1',
    googleProductId: 'kilopass_tier19',
    googleBasePlanId: 'monthly-v1',
    webMonthlyPriceUsd: 19,
    suggestedStoreMonthlyPriceUsd: 24.7,
    appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
    displayPrice: '$24.99',
    title: 'Kilo Pass 19',
    description: 'Kilo Pass',
    storeProduct: {
      id: 'kilopass.tier19.monthly.v1',
      displayPrice: '$24.99',
      title: 'Kilo Pass 19',
      description: 'Kilo Pass',
    },
  },
];

describe('getStoreKiloPassProductsState', () => {
  it('hides stale products when a refetch fails after products were loaded', () => {
    expect(
      getStoreKiloPassProductsState({
        data: products,
        isError: true,
        storeErrorMessage: null,
        queryErrorMessage: 'App Store timed out.',
      })
    ).toEqual({
      products: [],
      isError: true,
      errorMessage: 'App Store timed out.',
    });
  });

  it('restores products after a successful load clears the error state', () => {
    expect(
      getStoreKiloPassProductsState({
        data: products,
        isError: false,
        storeErrorMessage: null,
        queryErrorMessage: null,
      })
    ).toEqual({
      products,
      isError: false,
      errorMessage: null,
    });
  });
});

describe('isStoreKiloPassProductsLoading', () => {
  const base = {
    queryIsLoading: false,
    isIapPlatform: true,
    isStoreConnected: true,
    storeErrorMessage: null,
  };

  it('paints cached products while the store reconnects on a re-entry', () => {
    expect(
      isStoreKiloPassProductsLoading({
        ...base,
        data: products,
        isStoreConnected: false,
      })
    ).toBe(false);
  });

  it('waits for the store connection while there is nothing to paint', () => {
    expect(
      isStoreKiloPassProductsLoading({
        ...base,
        data: undefined,
        isStoreConnected: false,
      })
    ).toBe(true);
  });

  it('shows the skeleton while the first load runs', () => {
    expect(
      isStoreKiloPassProductsLoading({
        ...base,
        data: undefined,
        queryIsLoading: true,
      })
    ).toBe(true);
  });

  it('does not show the skeleton once the connection wait timed out', () => {
    expect(
      isStoreKiloPassProductsLoading({
        ...base,
        data: undefined,
        isStoreConnected: false,
        storeErrorMessage: 'Could not connect.',
      })
    ).toBe(false);
  });
});
