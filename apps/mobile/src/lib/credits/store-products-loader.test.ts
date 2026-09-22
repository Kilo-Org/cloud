import { describe, expect, it, vi } from 'vitest';

import {
  getAuthoredProductsErrorMessageKey,
  loadStoreCreditProducts,
  NO_MATCHING_CREDIT_PRODUCTS_KEY,
  NO_MATCHING_CREDIT_PRODUCTS_PLAY_KEY,
  StoreCreditProductsError,
} from './store-products-loader';
import { type BackendStoreCreditProduct } from './store-products';

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

  it('surfaces the App Store key when the store call itself fails', async () => {
    await expect(
      loadStoreCreditProducts({
        storefront: 'app_store',
        fetchStoreProducts: vi.fn().mockRejectedValue(new Error('Failed to query product for sku')),
        loadBackendProducts: loadBackendProducts(),
      })
    ).rejects.toThrow(NO_MATCHING_CREDIT_PRODUCTS_KEY);
  });

  it('surfaces the Play key when the store call itself fails', async () => {
    await expect(
      loadStoreCreditProducts({
        storefront: 'play',
        fetchStoreProducts: vi.fn().mockRejectedValue(new Error('Failed to query product for sku')),
        loadBackendProducts: loadBackendProducts(),
      })
    ).rejects.toThrow(NO_MATCHING_CREDIT_PRODUCTS_PLAY_KEY);
  });

  it('surfaces the App Store key when the store prices no pack', async () => {
    await expect(
      loadStoreCreditProducts({
        storefront: 'app_store',
        fetchStoreProducts: vi.fn().mockResolvedValue([]),
        loadBackendProducts: loadBackendProducts(),
      })
    ).rejects.toThrow(NO_MATCHING_CREDIT_PRODUCTS_KEY);
  });

  it('surfaces the Play key when the store prices no pack', async () => {
    await expect(
      loadStoreCreditProducts({
        storefront: 'play',
        fetchStoreProducts: vi.fn().mockResolvedValue([]),
        loadBackendProducts: loadBackendProducts(),
      })
    ).rejects.toThrow(NO_MATCHING_CREDIT_PRODUCTS_PLAY_KEY);
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

describe('getAuthoredProductsErrorMessageKey', () => {
  it('keeps the catalog key this app wrote', () => {
    expect(
      getAuthoredProductsErrorMessageKey(new StoreCreditProductsError('credits.noMatchingProducts'))
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
