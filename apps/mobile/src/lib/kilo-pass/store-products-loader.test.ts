import { describe, expect, it, vi } from 'vitest';

import {
  loadAppStoreKiloPassProducts,
  NO_MATCHING_KILO_PASS_PRODUCTS_MESSAGE,
} from './store-products-loader';
import { type BackendStoreKiloPassProduct } from './store-products';

const backendProducts: BackendStoreKiloPassProduct[] = [
  {
    tier: 'tier_19',
    cadence: 'monthly',
    appleProductId: 'kilopass.tier19.monthly.v1',
    googleProductId: 'kilopass_tier19',
    googleBasePlanId: 'monthly-v1',
    webMonthlyPriceUsd: 19,
    suggestedStoreMonthlyPriceUsd: 24.7,
  },
  {
    tier: 'tier_49',
    cadence: 'monthly',
    appleProductId: 'kilopass.tier49.monthly.v1',
    googleProductId: 'kilopass_tier49',
    googleBasePlanId: 'monthly-v1',
    webMonthlyPriceUsd: 49,
    suggestedStoreMonthlyPriceUsd: 63.7,
  },
];

describe('loadAppStoreKiloPassProducts', () => {
  it('returns joined products only after backend and App Store products resolve', async () => {
    const fetchStoreProducts = vi.fn().mockResolvedValue([
      {
        id: 'kilopass.tier19.monthly.v1',
        displayPrice: '$24.99',
        title: 'Kilo Pass 19',
        description: 'Kilo Pass',
      },
    ]);

    const products = await loadAppStoreKiloPassProducts({
      fetchStoreProducts,
      loadBackendProducts: vi.fn().mockResolvedValue({
        appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
        products: backendProducts,
      }),
    });

    expect(fetchStoreProducts).toHaveBeenCalledWith([
      'kilopass.tier19.monthly.v1',
      'kilopass.tier49.monthly.v1',
    ]);
    expect(products).toEqual([
      expect.objectContaining({
        appleProductId: 'kilopass.tier19.monthly.v1',
        appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
        displayPrice: '$24.99',
      }),
    ]);
  });

  it('throws the empty App Store message after the store fetch returns no matching products', async () => {
    await expect(
      loadAppStoreKiloPassProducts({
        fetchStoreProducts: vi.fn().mockResolvedValue([]),
        loadBackendProducts: vi.fn().mockResolvedValue({
          appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
          products: backendProducts,
        }),
      })
    ).rejects.toThrow(NO_MATCHING_KILO_PASS_PRODUCTS_MESSAGE);
  });
});
