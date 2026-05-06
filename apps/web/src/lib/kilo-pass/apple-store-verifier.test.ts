import { describe, expect, it } from '@jest/globals';

import { KiloPassCadence, KiloPassPaymentProvider, KiloPassTier } from './enums';
import { mapAppleKiloPassTransaction } from './apple-store-verifier';
import type { AppleStoreDecodedTransaction } from './apple-store-verifier';

function transaction(
  overrides: Partial<AppleStoreDecodedTransaction> = {}
): AppleStoreDecodedTransaction {
  return {
    transactionId: 'tx-1',
    originalTransactionId: 'orig-1',
    bundleId: 'com.kilocode.kiloapp',
    productId: 'kilopass.tier19.yearly.v1',
    purchaseDate: 1_777_626_000_000,
    environment: 'Sandbox',
    rawPayload: { transactionId: 'tx-1' },
    ...overrides,
  };
}

describe('mapAppleKiloPassTransaction', () => {
  it('maps a valid App Store transaction to a validated Kilo Pass purchase', () => {
    expect(mapAppleKiloPassTransaction(transaction())).toMatchObject({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      productId: 'kilopass.tier19.yearly.v1',
      providerTransactionId: 'tx-1',
      providerSubscriptionId: 'orig-1',
      providerOriginalTransactionId: 'orig-1',
      environment: 'Sandbox',
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Yearly,
    });
  });

  it('rejects the wrong bundle id', () => {
    expect(() => mapAppleKiloPassTransaction(transaction({ bundleId: 'com.example.bad' }))).toThrow(
      'Apple transaction bundle mismatch'
    );
  });

  it('rejects revoked transactions', () => {
    expect(() => mapAppleKiloPassTransaction(transaction({ revocationDate: 1 }))).toThrow(
      'Apple transaction has been revoked'
    );
  });

  it('rejects unknown products', () => {
    expect(() => mapAppleKiloPassTransaction(transaction({ productId: 'unknown' }))).toThrow(
      'Apple Kilo Pass product is not enabled'
    );
  });

  it('requires original transaction id for subscription identity', () => {
    expect(() => mapAppleKiloPassTransaction(transaction({ originalTransactionId: '' }))).toThrow(
      'Apple transaction payload missing required identifiers'
    );
  });
});
