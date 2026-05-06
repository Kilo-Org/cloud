import { describe, expect, it } from 'vitest';

import { joinAppStoreKiloPassProducts } from './store-products';

describe('joinAppStoreKiloPassProducts', () => {
  it('joins backend Apple product ids to localized App Store subscription metadata', () => {
    const products = joinAppStoreKiloPassProducts({
      backendProducts: [
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
      ],
      storeProducts: [
        {
          id: 'kilopass.tier19.monthly.v1',
          displayPrice: '$24.99',
          title: 'Kilo Pass 19',
          description: 'Kilo Pass',
        },
      ],
    });

    expect(products).toEqual([
      expect.objectContaining({
        tier: 'tier_19',
        cadence: 'monthly',
        appleProductId: 'kilopass.tier19.monthly.v1',
        displayPrice: '$24.99',
        title: 'Kilo Pass 19',
      }),
    ]);
  });
});
