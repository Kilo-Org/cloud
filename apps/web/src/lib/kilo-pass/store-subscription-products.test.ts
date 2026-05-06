import { describe, expect, it } from '@jest/globals';

import { KiloPassCadence, KiloPassTier } from './enums';
import {
  getAllMobileStoreKiloPassProducts,
  getMobileStoreKiloPassProduct,
} from './mobile-store-products';

describe('mobile Kilo Pass store products', () => {
  it('maps every tier and cadence to Apple and Google product identifiers', () => {
    const products = getAllMobileStoreKiloPassProducts();

    expect(products).toHaveLength(6);
    for (const tier of Object.values(KiloPassTier)) {
      for (const cadence of Object.values(KiloPassCadence)) {
        const product = getMobileStoreKiloPassProduct({ tier, cadence });
        expect(product).toMatchObject({ tier, cadence });
        expect(product.appleProductId).toMatch(/^kilopass\./);
        expect(product.googleProductId).toMatch(/^kilopass_tier/);
        expect(product.googleBasePlanId).toMatch(/^(monthly|yearly)-v1$/);
        expect(product.webMonthlyPriceUsd).toBeGreaterThan(0);
        expect(product.suggestedStoreMonthlyPriceUsd).toBeGreaterThan(product.webMonthlyPriceUsd);
      }
    }
  });
});
