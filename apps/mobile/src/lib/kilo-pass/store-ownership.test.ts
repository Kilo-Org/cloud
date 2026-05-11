import { type Purchase } from 'expo-iap';
import { describe, expect, it } from 'vitest';

import { getAppStoreKiloPassOwnership } from './store-ownership';

function purchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    appAccountToken: 'account-a',
    id: 'purchase-1',
    ids: null,
    isAutoRenewing: true,
    platform: 'ios',
    productId: 'kilopass.tier19.monthly.v1',
    purchaseState: 'purchased',
    purchaseToken: 'signed-jws',
    quantity: 1,
    store: 'apple',
    transactionDate: Date.now(),
    transactionId: 'tx-1',
    ...overrides,
  };
}

const enabledAppleProductIds = ['com.kilo.pass.tier19.monthly'];

describe('getAppStoreKiloPassOwnership', () => {
  it('detects a Kilo Pass subscription owned by the current account', () => {
    expect(
      getAppStoreKiloPassOwnership({
        appAccountToken: 'account-a',
        enabledAppleProductIds,
        purchases: [purchase({ productId: 'com.kilo.pass.tier19.monthly' })],
      })
    ).toBe('current-account');
  });

  it('detects a Kilo Pass subscription owned by another account', () => {
    expect(
      getAppStoreKiloPassOwnership({
        appAccountToken: 'account-b',
        enabledAppleProductIds,
        purchases: [purchase({ productId: 'com.kilo.pass.tier19.monthly' })],
      })
    ).toBe('another-account');
  });

  it('ignores pending and non-Kilo Pass purchases', () => {
    expect(
      getAppStoreKiloPassOwnership({
        appAccountToken: 'account-b',
        enabledAppleProductIds,
        purchases: [
          purchase({ productId: 'other.product' }),
          purchase({ id: 'pending', purchaseState: 'pending', transactionId: 'tx-pending' }),
        ],
      })
    ).toBe('none');
  });
});
