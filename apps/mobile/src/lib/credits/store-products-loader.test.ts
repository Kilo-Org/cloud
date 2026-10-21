import { describe, expect, it, vi } from 'vitest';

import {
  getAuthoredProductsErrorMessageKey,
  getStoreUnavailableCopyKeys,
  loadStoreCreditProducts,
  NO_MATCHING_CREDIT_PRODUCTS_KEY,
  NO_MATCHING_CREDIT_PRODUCTS_PLAY_KEY,
  StoreCreditProductsError,
} from './store-products-loader';
import { type BackendStoreCreditProduct } from './store-products';
import { TELEMETRY_DESCRIPTION_KEY } from '@/lib/telemetry/error-sink';

const backendProducts: BackendStoreCreditProduct[] = [
  { amountUsd: 10, appleProductId: 'credits.usd10.v1', googleProductId: 'credits_usd10' },
  { amountUsd: 50, appleProductId: 'credits.usd50.v1', googleProductId: 'credits_usd50' },
  { amountUsd: 100, appleProductId: 'credits.usd100.v1', googleProductId: 'credits_usd100' },
  { amountUsd: 500, appleProductId: 'credits.usd500.v1', googleProductId: 'credits_usd500' },
];

const backendResponse = {
  appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
  products: backendProducts,
};

const APPLE_REQUESTED_IDS = [
  'credits.usd10.v1',
  'credits.usd50.v1',
  'credits.usd100.v1',
  'credits.usd500.v1',
];
const PLAY_REQUESTED_IDS = ['credits_usd10', 'credits_usd50', 'credits_usd100', 'credits_usd500'];

function loadBackendProducts() {
  return vi.fn().mockResolvedValue(backendResponse);
}

describe('loadStoreCreditProducts', () => {
  it('reads the backend catalog once and requests the storefront ids it drives', async () => {
    const loadBackendProductsMock = loadBackendProducts();
    const fetchStoreProducts = vi
      .fn()
      .mockResolvedValue([{ id: 'credits.usd10.v1', displayPrice: '$10.99' }]);

    const products = await loadStoreCreditProducts({
      storefront: 'app_store',
      fetchStoreProducts,
      loadBackendProducts: loadBackendProductsMock,
    });

    expect(loadBackendProductsMock).toHaveBeenCalledTimes(1);
    expect(fetchStoreProducts).toHaveBeenCalledWith([
      'credits.usd10.v1',
      'credits.usd50.v1',
      'credits.usd100.v1',
      'credits.usd500.v1',
    ]);
    expect(products).toHaveLength(4);
    expect(products[0]?.displayPrice).toBe('$10.99');
    expect(products[1]?.displayPrice).toBeNull();
  });

  it('requests the Google ids on the Play storefront', async () => {
    const fetchStoreProducts = vi
      .fn()
      .mockResolvedValue([{ id: 'credits_usd10', displayPrice: '€10.99' }]);

    await loadStoreCreditProducts({
      storefront: 'play',
      fetchStoreProducts,
      loadBackendProducts: loadBackendProducts(),
    });

    expect(fetchStoreProducts).toHaveBeenCalledWith([
      'credits_usd10',
      'credits_usd50',
      'credits_usd100',
      'credits_usd500',
    ]);
  });

  it('surfaces the App Store key with the store failure as cause when the store call fails', async () => {
    const storeError = new Error('Failed to query product for sku');

    const failure = await loadStoreCreditProducts({
      storefront: 'app_store',
      fetchStoreProducts: vi.fn().mockRejectedValue(storeError),
      loadBackendProducts: loadBackendProducts(),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StoreCreditProductsError);
    expect(failure).toMatchObject({ key: NO_MATCHING_CREDIT_PRODUCTS_KEY });
    expect((failure as StoreCreditProductsError).cause).toBe(storeError);
    expect((failure as StoreCreditProductsError).diagnostics).toEqual({
      storefront: 'app_store',
      backendPackCount: 4,
      storeListingCount: 0,
      matchedCount: 0,
      requestedProductIds: APPLE_REQUESTED_IDS,
      returnedProductIds: [],
    });
  });

  it('surfaces the Play key with the store failure as cause when the store call fails', async () => {
    const storeError = new Error('Failed to query product for sku');

    const failure = await loadStoreCreditProducts({
      storefront: 'play',
      fetchStoreProducts: vi.fn().mockRejectedValue(storeError),
      loadBackendProducts: loadBackendProducts(),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StoreCreditProductsError);
    expect(failure).toMatchObject({ key: NO_MATCHING_CREDIT_PRODUCTS_PLAY_KEY });
    expect((failure as StoreCreditProductsError).cause).toBe(storeError);
    expect((failure as StoreCreditProductsError).diagnostics).toEqual({
      storefront: 'play',
      backendPackCount: 4,
      storeListingCount: 0,
      matchedCount: 0,
      requestedProductIds: PLAY_REQUESTED_IDS,
      returnedProductIds: [],
    });
  });

  it('surfaces the App Store key with both sides ids when the store prices no pack', async () => {
    const failure = await loadStoreCreditProducts({
      storefront: 'app_store',
      fetchStoreProducts: vi
        .fn()
        .mockResolvedValue([{ id: 'credits.usd250.v1', displayPrice: '$249.99' }]),
      loadBackendProducts: loadBackendProducts(),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StoreCreditProductsError);
    expect(failure).toMatchObject({ key: NO_MATCHING_CREDIT_PRODUCTS_KEY });
    expect((failure as StoreCreditProductsError).cause).toBeUndefined();
    expect((failure as StoreCreditProductsError).diagnostics).toEqual({
      storefront: 'app_store',
      backendPackCount: 4,
      storeListingCount: 1,
      matchedCount: 0,
      requestedProductIds: APPLE_REQUESTED_IDS,
      returnedProductIds: ['credits.usd250.v1'],
    });
  });

  it('surfaces the Play key with both sides ids when the store prices no pack', async () => {
    const failure = await loadStoreCreditProducts({
      storefront: 'play',
      fetchStoreProducts: vi.fn().mockResolvedValue([]),
      loadBackendProducts: loadBackendProducts(),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StoreCreditProductsError);
    expect(failure).toMatchObject({ key: NO_MATCHING_CREDIT_PRODUCTS_PLAY_KEY });
    expect((failure as StoreCreditProductsError).cause).toBeUndefined();
    expect((failure as StoreCreditProductsError).diagnostics).toEqual({
      storefront: 'play',
      backendPackCount: 4,
      storeListingCount: 0,
      matchedCount: 0,
      requestedProductIds: PLAY_REQUESTED_IDS,
      returnedProductIds: [],
    });
  });

  it('keeps a partial store answer instead of erroring', async () => {
    const products = await loadStoreCreditProducts({
      storefront: 'play',
      fetchStoreProducts: vi
        .fn()
        .mockResolvedValue([{ id: 'credits_usd100', displayPrice: '€109.99' }]),
      loadBackendProducts: loadBackendProducts(),
    });

    expect(products).toHaveLength(4);
    expect(products.filter(product => product.displayPrice !== null)).toHaveLength(1);
    expect(products[2]?.displayPrice).toBe('€109.99');
  });

  it('does not touch the store when the backend catalog is empty', async () => {
    const fetchStoreProducts = vi.fn();

    const products = await loadStoreCreditProducts({
      storefront: 'app_store',
      fetchStoreProducts,
      loadBackendProducts: vi.fn().mockResolvedValue({
        appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
        products: [],
      }),
    });

    expect(fetchStoreProducts).not.toHaveBeenCalled();
    expect(products).toEqual([]);
  });
});

describe('getStoreUnavailableCopyKeys', () => {
  it('names the App Store for the app_store storefront on both lines', () => {
    expect(getStoreUnavailableCopyKeys('app_store')).toEqual({
      titleKey: 'kiloPass.productsUnavailable',
      bodyKey: NO_MATCHING_CREDIT_PRODUCTS_KEY,
    });
  });

  it('names Google Play for the play storefront on both lines', () => {
    expect(getStoreUnavailableCopyKeys('play')).toEqual({
      titleKey: 'kiloPass.productsUnavailablePlay',
      bodyKey: NO_MATCHING_CREDIT_PRODUCTS_PLAY_KEY,
    });
  });
});

describe('StoreCreditProductsError telemetry', () => {
  it('files a zero-match answer as a warning under the storefront unavailable fingerprint', () => {
    const error = new StoreCreditProductsError(NO_MATCHING_CREDIT_PRODUCTS_KEY, {
      storefront: 'play',
      backendPackCount: 4,
      storeListingCount: 2,
      matchedCount: 0,
      requestedProductIds: PLAY_REQUESTED_IDS,
      returnedProductIds: ['credits_usd25', 'credits_usd75'],
    });

    expect(error[TELEMETRY_DESCRIPTION_KEY]).toEqual({
      level: 'warning',
      fingerprint: ['credit-catalog-query', 'store-unavailable', 'play'],
      tags: {
        'error.subsystem': 'credits',
        'error.operation': 'load-store-products',
        'credits.storefront': 'play',
        'credits.outcome': 'store-unavailable',
      },
      contexts: {
        creditCatalogQuery: {
          storefront: 'play',
          backendPackCount: 4,
          storeListingCount: 2,
          matchedCount: 0,
          requestedProductIds: PLAY_REQUESTED_IDS,
          returnedProductIds: ['credits_usd25', 'credits_usd75'],
        },
      },
    });
  });

  it('files a store failure as an error under the storefront error fingerprint', () => {
    const cause = new Error('Failed to query product');
    const error = new StoreCreditProductsError(
      NO_MATCHING_CREDIT_PRODUCTS_KEY,
      {
        storefront: 'app_store',
        backendPackCount: 4,
        storeListingCount: 0,
        matchedCount: 0,
        requestedProductIds: APPLE_REQUESTED_IDS,
        returnedProductIds: [],
      },
      { cause }
    );

    expect(error[TELEMETRY_DESCRIPTION_KEY]).toEqual({
      level: 'error',
      fingerprint: ['credit-catalog-query', 'store-error', 'app_store'],
      tags: {
        'error.subsystem': 'credits',
        'error.operation': 'load-store-products',
        'credits.storefront': 'app_store',
        'credits.outcome': 'store-error',
      },
      contexts: {
        creditCatalogQuery: {
          storefront: 'app_store',
          backendPackCount: 4,
          storeListingCount: 0,
          matchedCount: 0,
          requestedProductIds: APPLE_REQUESTED_IDS,
          returnedProductIds: [],
        },
      },
    });
  });
});

describe('getAuthoredProductsErrorMessageKey', () => {
  it('keeps the catalog key this app wrote', () => {
    expect(
      getAuthoredProductsErrorMessageKey(
        new StoreCreditProductsError('credits.noMatchingProducts', {
          storefront: 'app_store',
          backendPackCount: 0,
          storeListingCount: 0,
          matchedCount: 0,
          requestedProductIds: [],
          returnedProductIds: [],
        })
      )
    ).toBe('credits.noMatchingProducts');
  });

  it('drops a store SDK message so the screen uses its own localized copy', () => {
    expect(getAuthoredProductsErrorMessageKey(new Error('Failed to query product'))).toBeNull();
  });

  it('drops a non-error rejection', () => {
    expect(getAuthoredProductsErrorMessageKey('Failed to query product')).toBeNull();
    expect(getAuthoredProductsErrorMessageKey(null)).toBeNull();
  });
});
