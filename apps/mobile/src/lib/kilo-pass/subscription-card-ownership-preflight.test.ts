import { describe, expect, it, vi } from 'vitest';

import { getAppStoreKiloPassOwnershipPreflight } from './subscription-card-state';

vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => 'en',
}));

const currentAppAccountToken = '550e8400-e29b-41d4-a716-446655440000';
const otherAppAccountToken = '550e8400-e29b-41d4-a716-446655440001';
const appleProductId = 'com.kilo.pass.tier19.monthly';
const googleProductId = 'kilopass_tier19';

describe('getAppStoreKiloPassOwnershipPreflight', () => {
  it('flags an iOS Kilo Pass purchase owned by a different app account token', () => {
    expect(
      getAppStoreKiloPassOwnershipPreflight({
        availablePurchases: [
          {
            appAccountToken: otherAppAccountToken,
            productId: appleProductId,
            purchaseState: 'purchased',
            store: 'apple',
          },
        ],
        currentAppAccountToken,
        enabledAppleProductIds: [appleProductId],
        enabledGoogleProductIds: [],
        platformOS: 'ios',
      })
    ).toBe('owned-by-another-account');
  });

  it('does not flag current-account iOS Kilo Pass purchases', () => {
    expect(
      getAppStoreKiloPassOwnershipPreflight({
        availablePurchases: [
          {
            appAccountToken: currentAppAccountToken,
            productId: appleProductId,
            purchaseState: 'purchased',
            store: 'apple',
          },
        ],
        currentAppAccountToken,
        enabledAppleProductIds: [appleProductId],
        enabledGoogleProductIds: [],
        platformOS: 'ios',
      })
    ).toBeNull();
  });

  it('does not flag purchases without an app account token', () => {
    expect(
      getAppStoreKiloPassOwnershipPreflight({
        availablePurchases: [
          {
            appAccountToken: null,
            productId: appleProductId,
            purchaseState: 'purchased',
            store: 'apple',
          },
        ],
        currentAppAccountToken,
        enabledAppleProductIds: [appleProductId],
        enabledGoogleProductIds: [],
        platformOS: 'ios',
      })
    ).toBeNull();
  });

  it('ignores non-Kilo, pending, non-Apple, and non-iOS purchases', () => {
    const purchases = [
      {
        appAccountToken: otherAppAccountToken,
        productId: 'com.kilo.other',
        purchaseState: 'purchased',
        store: 'apple',
      },
      {
        appAccountToken: otherAppAccountToken,
        productId: appleProductId,
        purchaseState: 'pending',
        store: 'apple',
      },
      {
        appAccountToken: otherAppAccountToken,
        productId: appleProductId,
        purchaseState: 'purchased',
        store: 'google',
      },
    ];

    expect(
      getAppStoreKiloPassOwnershipPreflight({
        availablePurchases: purchases,
        currentAppAccountToken,
        enabledAppleProductIds: [appleProductId],
        enabledGoogleProductIds: [],
        platformOS: 'ios',
      })
    ).toBeNull();
    expect(
      getAppStoreKiloPassOwnershipPreflight({
        availablePurchases: [
          {
            appAccountToken: otherAppAccountToken,
            productId: appleProductId,
            purchaseState: 'purchased',
            store: 'apple',
          },
        ],
        currentAppAccountToken,
        enabledAppleProductIds: [appleProductId],
        enabledGoogleProductIds: [],
        platformOS: 'android',
      })
    ).toBeNull();
  });

  it('flags an Android Kilo Pass purchase owned by a different Play account id', () => {
    expect(
      getAppStoreKiloPassOwnershipPreflight({
        availablePurchases: [
          {
            obfuscatedAccountIdAndroid: otherAppAccountToken,
            productId: googleProductId,
            purchaseState: 'purchased',
            store: 'google',
          },
        ],
        currentAppAccountToken,
        enabledAppleProductIds: [],
        enabledGoogleProductIds: [googleProductId],
        platformOS: 'android',
      })
    ).toBe('owned-by-another-account');
  });
});
