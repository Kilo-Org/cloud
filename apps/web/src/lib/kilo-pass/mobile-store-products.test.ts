import { describe, expect, it } from '@jest/globals';

import { KiloPassCadence, KiloPassTier } from './enums';
import {
  getMobileStoreKiloPassProductByAppleProductId,
  getMobileStoreKiloPassProductByGoogleProductId,
} from './mobile-store-products';

describe('mobile-store-products', () => {
  it('looks up a product by Google product id', () => {
    const product = getMobileStoreKiloPassProductByGoogleProductId('kilopass_tier19');

    expect(product?.tier).toBe(KiloPassTier.Tier19);
    expect(product?.cadence).toBe(KiloPassCadence.Monthly);
  });

  it('returns null for an unknown Google product id', () => {
    expect(getMobileStoreKiloPassProductByGoogleProductId('unknown_id')).toBeNull();
  });

  it('still looks up a product by Apple product id', () => {
    const product = getMobileStoreKiloPassProductByAppleProductId('kilopass.tier19.monthly.v1');

    expect(product?.tier).toBe(KiloPassTier.Tier19);
    expect(product?.cadence).toBe(KiloPassCadence.Monthly);
  });
});
