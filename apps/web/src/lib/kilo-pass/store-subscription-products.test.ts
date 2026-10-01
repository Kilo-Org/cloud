import { describe, expect, it } from '@jest/globals';

import { KiloPassCadence, KiloPassTier } from './enums';
import {
  getAllMobileStoreKiloPassProducts,
  getMobileStoreKiloPassProduct,
} from './mobile-store-products';

describe('mobile Kilo Pass store products', () => {
  it('exposes monthly store products for every tier', () => {
    const products = getAllMobileStoreKiloPassProducts();

    expect(products).toHaveLength(3);
    expect(products.map(product => product.appleProductId)).toEqual([
      'kilopass.tier199.monthly.v1',
      'kilopass.tier49.monthly.v1',
      'kilopass.tier19.monthly.v1',
    ]);
    for (const tier of Object.values(KiloPassTier)) {
      const product = getMobileStoreKiloPassProduct({ tier });
      expect(product).toMatchObject({ tier, cadence: KiloPassCadence.Monthly });
      expect(product.appleProductId).toMatch(/^kilopass\./);
      expect(product.appleProductId).not.toContain('yearly');
      expect(product.googleProductId).toMatch(/^kilopass_tier/);
      expect(product.googleBasePlanId).toBe('monthly-v1');
      expect(product.webMonthlyPriceUsd).toBeGreaterThan(0);
      expect(product.suggestedStoreMonthlyPriceUsd).toBeGreaterThan(product.webMonthlyPriceUsd);
    }
  });
});
