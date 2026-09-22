import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { androidpublisher_v3 } from '@googleapis/androidpublisher';

import type { AppleStoreDecodedTransaction } from '@/lib/kilo-pass/apple-store-verifier';
import type * as AppleStoreVerifier from '@/lib/kilo-pass/apple-store-verifier';
import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';
import type * as StoreVerifier from './store-verifier';

const mockGetGooglePlayProductPurchase =
  jest.fn<
    (
      productId: string,
      purchaseToken: string
    ) => Promise<androidpublisher_v3.Schema$ProductPurchase>
  >();

const mockConsumeGooglePlayProductPurchase =
  jest.fn<(productId: string, purchaseToken: string) => Promise<void>>();

const mockDecodeAppleStoreTransactionJws =
  jest.fn<(jws: string) => Promise<AppleStoreDecodedTransaction>>();

jest.mock('@/lib/kilo-pass/google-play-sdk', () => ({
  getGooglePlayProductPurchase: (...args: [string, string]) =>
    mockGetGooglePlayProductPurchase(...args),
  consumeGooglePlayProductPurchase: (...args: [string, string]) =>
    mockConsumeGooglePlayProductPurchase(...args),
}));

jest.mock('@/lib/kilo-pass/apple-store-verifier', () => {
  const actual = jest.requireActual<typeof AppleStoreVerifier>(
    '@/lib/kilo-pass/apple-store-verifier'
  );
  return {
    ...actual,
    decodeAppleStoreTransactionJws: (...args: [string]) =>
      mockDecodeAppleStoreTransactionJws(...args),
  };
});

function loadVerifier(): typeof StoreVerifier {
  return jest.requireActual<typeof StoreVerifier>('./store-verifier');
}

type AppleTransactionFixture = AppleStoreDecodedTransaction & { quantity?: number };

function transaction(overrides: Partial<AppleTransactionFixture> = {}): AppleTransactionFixture {
  return {
    transactionId: 'tx-1',
    originalTransactionId: 'orig-1',
    bundleId: 'com.kilocode.kiloapp',
    productId: 'credits.usd10.v1',
    purchaseDate: 1_777_626_000_000,
    appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
    environment: 'Sandbox',
    rawPayload: { transactionId: 'tx-1' },
    ...overrides,
  };
}

function productPurchase(
  overrides: Partial<androidpublisher_v3.Schema$ProductPurchase> = {}
): androidpublisher_v3.Schema$ProductPurchase {
  return {
    productId: 'credits_usd10',
    purchaseState: 0,
    orderId: 'GPA.1234',
    obfuscatedExternalAccountId: '550e8400-e29b-41d4-a716-446655440000',
    purchaseTimeMillis: '1777626000000',
    ...overrides,
  };
}

describe('mapAppleCreditTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps a valid consumable transaction with quantity 1', () => {
    const { mapAppleCreditTransaction } = loadVerifier();

    expect(mapAppleCreditTransaction(transaction())).toEqual({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      productId: 'credits.usd10.v1',
      providerTransactionId: 'tx-1',
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      quantity: 1,
      amountUsd: 10,
      amountMicrodollars: 10_000_000,
      purchasedAtIso: new Date(1_777_626_000_000).toISOString(),
      environment: 'Sandbox',
      rawPayload: { transactionId: 'tx-1' },
    });
  });

  it('multiplies the microdollar amount by the purchased quantity', () => {
    const { mapAppleCreditTransaction } = loadVerifier();

    expect(mapAppleCreditTransaction(transaction({ quantity: 3 }))).toMatchObject({
      quantity: 3,
      amountUsd: 10,
      amountMicrodollars: 30_000_000,
    });
  });

  it('reads the quantity from the raw payload when it is not attached', () => {
    const { mapAppleCreditTransaction } = loadVerifier();

    expect(
      mapAppleCreditTransaction(transaction({ rawPayload: { transactionId: 'tx-1', quantity: 2 } }))
    ).toMatchObject({ quantity: 2, amountMicrodollars: 20_000_000 });
  });

  it('maps a null account token', () => {
    const { mapAppleCreditTransaction } = loadVerifier();

    expect(
      mapAppleCreditTransaction(transaction({ appAccountToken: undefined })).appAccountToken
    ).toBeNull();
  });

  it('rejects the wrong bundle id', () => {
    const { mapAppleCreditTransaction } = loadVerifier();

    expect(() => mapAppleCreditTransaction(transaction({ bundleId: 'com.example.bad' }))).toThrow(
      'Apple transaction bundle mismatch'
    );
  });

  it('rejects a revoked transaction', () => {
    const { mapAppleCreditTransaction } = loadVerifier();

    expect(() => mapAppleCreditTransaction(transaction({ revocationDate: 1 }))).toThrow(
      'Apple transaction has been revoked'
    );
  });

  it('rejects a transaction with an expiration date', () => {
    const { mapAppleCreditTransaction } = loadVerifier();

    expect(() =>
      mapAppleCreditTransaction(transaction({ expiresDate: 4_102_444_800_000 }))
    ).toThrow('Apple credit purchase is not a consumable');
  });

  it('rejects an unknown product id', () => {
    const { mapAppleCreditTransaction } = loadVerifier();

    expect(() => mapAppleCreditTransaction(transaction({ productId: 'unknown' }))).toThrow(
      'Apple transaction product is not a credit pack'
    );
  });

  it('rejects missing identifiers', () => {
    const { mapAppleCreditTransaction } = loadVerifier();

    expect(() => mapAppleCreditTransaction(transaction({ transactionId: '' }))).toThrow(
      'Apple transaction is missing identifiers'
    );
  });

  it.each([0, 1.5, 101])('rejects the out-of-range quantity %s', quantity => {
    const { mapAppleCreditTransaction } = loadVerifier();

    expect(() => mapAppleCreditTransaction(transaction({ quantity }))).toThrow(
      'Apple transaction quantity is out of range'
    );
  });
});

describe('verifyAppleCreditPurchase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('decodes the signed transaction and maps it', async () => {
    const { verifyAppleCreditPurchase } = loadVerifier();
    mockDecodeAppleStoreTransactionJws.mockResolvedValueOnce(transaction({ quantity: 2 }));

    const result = await verifyAppleCreditPurchase('signed-jws');

    expect(mockDecodeAppleStoreTransactionJws).toHaveBeenCalledWith('signed-jws');
    expect(result).toMatchObject({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      productId: 'credits.usd10.v1',
      providerTransactionId: 'tx-1',
      quantity: 2,
      amountMicrodollars: 20_000_000,
    });
  });
});

describe('verifyGooglePlayCreditPurchase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('validates a purchased product and maps it', async () => {
    const { verifyGooglePlayCreditPurchase } = loadVerifier();
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(productPurchase());

    const result = await verifyGooglePlayCreditPurchase({
      productId: 'credits_usd10',
      purchaseToken: 'purchase-token',
    });

    expect(mockGetGooglePlayProductPurchase).toHaveBeenCalledWith(
      'credits_usd10',
      'purchase-token'
    );
    expect(result).toMatchObject({
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
      productId: 'credits_usd10',
      providerTransactionId: 'GPA.1234',
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      quantity: 1,
      amountUsd: 10,
      amountMicrodollars: 10_000_000,
      purchasedAtIso: new Date(1_777_626_000_000).toISOString(),
      environment: 'Production',
    });
  });

  it.each([1, 2])('rejects purchaseState %s', async purchaseState => {
    const { verifyGooglePlayCreditPurchase } = loadVerifier();
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(productPurchase({ purchaseState }));

    await expect(
      verifyGooglePlayCreditPurchase({
        productId: 'credits_usd10',
        purchaseToken: 'purchase-token',
      })
    ).rejects.toThrow('Google Play purchase is not in a purchased state');
  });

  it('rejects an unknown product id', async () => {
    const { verifyGooglePlayCreditPurchase } = loadVerifier();
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(
      productPurchase({ productId: 'unknown_sku' })
    );

    await expect(
      verifyGooglePlayCreditPurchase({ productId: 'unknown_sku', purchaseToken: 'purchase-token' })
    ).rejects.toThrow('Google Play purchase product is not a credit pack');
  });

  it('rejects a response product id that differs from the request', async () => {
    const { verifyGooglePlayCreditPurchase } = loadVerifier();
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(
      productPurchase({ productId: 'credits_usd50' })
    );

    await expect(
      verifyGooglePlayCreditPurchase({
        productId: 'credits_usd10',
        purchaseToken: 'purchase-token',
      })
    ).rejects.toThrow('Google Play purchase product is not a credit pack');
  });

  it('honours the purchased quantity', async () => {
    const { verifyGooglePlayCreditPurchase } = loadVerifier();
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(productPurchase({ quantity: 3 }));

    const result = await verifyGooglePlayCreditPurchase({
      productId: 'credits_usd10',
      purchaseToken: 'purchase-token',
    });

    expect(result).toMatchObject({ quantity: 3, amountMicrodollars: 30_000_000 });
  });

  it.each([0, 1.5, 101])('rejects the out-of-range quantity %s', async quantity => {
    const { verifyGooglePlayCreditPurchase } = loadVerifier();
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(productPurchase({ quantity }));

    await expect(
      verifyGooglePlayCreditPurchase({
        productId: 'credits_usd10',
        purchaseToken: 'purchase-token',
      })
    ).rejects.toThrow('Google Play purchase quantity is out of range');
  });

  it('falls back to the purchase token when the order id is absent', async () => {
    const { verifyGooglePlayCreditPurchase } = loadVerifier();
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(productPurchase({ orderId: null }));

    const result = await verifyGooglePlayCreditPurchase({
      productId: 'credits_usd10',
      purchaseToken: 'purchase-token',
    });

    expect(result.providerTransactionId).toBe('purchase-token');
  });

  it('marks a test purchase as Sandbox', async () => {
    const { verifyGooglePlayCreditPurchase } = loadVerifier();
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(productPurchase({ purchaseType: 0 }));

    const result = await verifyGooglePlayCreditPurchase({
      productId: 'credits_usd10',
      purchaseToken: 'purchase-token',
    });

    expect(result.environment).toBe('Sandbox');
  });
});

describe('acknowledgeGooglePlayCreditPurchase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('consumes the purchase through the sdk and tolerates a consumed result', async () => {
    const { acknowledgeGooglePlayCreditPurchase } = loadVerifier();
    mockConsumeGooglePlayProductPurchase.mockResolvedValueOnce(undefined);

    await expect(
      acknowledgeGooglePlayCreditPurchase('credits_usd10', 'purchase-token')
    ).resolves.toBeUndefined();
    expect(mockConsumeGooglePlayProductPurchase).toHaveBeenCalledWith(
      'credits_usd10',
      'purchase-token'
    );
  });

  it('rethrows a real consume failure', async () => {
    const { acknowledgeGooglePlayCreditPurchase } = loadVerifier();
    mockConsumeGooglePlayProductPurchase.mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(
      acknowledgeGooglePlayCreditPurchase('credits_usd10', 'purchase-token')
    ).rejects.toThrow('provider unavailable');
  });
});
