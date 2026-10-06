import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { androidpublisher_v3 } from '@googleapis/androidpublisher';

import type { AppleStoreDecodedTransaction } from '@/lib/kilo-pass/apple-store-verifier';
import type * as AppleStoreVerifier from '@/lib/kilo-pass/apple-store-verifier';
import { KiloPassPaymentProvider } from '@kilocode/web-shared/lib/kilo-pass/enums';
import {
  STORE_PURCHASE_PENDING_MESSAGE,
  StorePurchasePendingError,
  StoreVerificationError,
} from './store-purchase-errors';
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
      googlePlayPurchaseToken: null,
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
      // The refund-event lookup needs the token, and the Play response does not
      // echo it, so it is carried on the purchase explicitly.
      googlePlayPurchaseToken: 'purchase-token',
      quantity: 1,
      amountUsd: 10,
      amountMicrodollars: 10_000_000,
      purchasedAtIso: new Date(1_777_626_000_000).toISOString(),
      environment: 'Production',
    });
  });

  it('rejects a canceled purchaseState as a terminal verification failure', async () => {
    const { verifyGooglePlayCreditPurchase } = loadVerifier();
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(productPurchase({ purchaseState: 1 }));

    const verification = verifyGooglePlayCreditPurchase({
      productId: 'credits_usd10',
      purchaseToken: 'purchase-token',
    });

    await expect(verification).rejects.toBeInstanceOf(StoreVerificationError);
    await expect(verification).rejects.toThrow('Google Play purchase is not in a purchased state');
  });

  // Play reports 2 while it finishes the charge, and the very same token turns
  // into 0 once it does. A pending response must not be a terminal receipt
  // defect: the mobile client would remember the refusal and never credit the
  // later-approved purchase.
  it('reports purchaseState 2 as pending, then verifies the same token once it becomes 0', async () => {
    const { verifyGooglePlayCreditPurchase } = loadVerifier();
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(productPurchase({ purchaseState: 2 }));

    const pending = verifyGooglePlayCreditPurchase({
      productId: 'credits_usd10',
      purchaseToken: 'purchase-token',
    });

    await expect(pending).rejects.toBeInstanceOf(StorePurchasePendingError);
    await expect(pending).rejects.toThrow(STORE_PURCHASE_PENDING_MESSAGE);

    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(productPurchase({ purchaseState: 0 }));
    const result = await verifyGooglePlayCreditPurchase({
      productId: 'credits_usd10',
      purchaseToken: 'purchase-token',
    });

    expect(result).toMatchObject({
      providerTransactionId: 'GPA.1234',
      quantity: 1,
      amountUsd: 10,
      amountMicrodollars: 10_000_000,
    });
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

  // The live API omits `productId` for a one-time product purchase, so a response
  // without it must resolve the product from the requested id.
  it('maps a response that carries no product id', async () => {
    const { verifyGooglePlayCreditPurchase } = loadVerifier();
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(productPurchase({ productId: null }));

    const result = await verifyGooglePlayCreditPurchase({
      productId: 'credits_usd10',
      purchaseToken: 'purchase-token',
    });

    expect(result).toMatchObject({
      productId: 'credits_usd10',
      quantity: 1,
      amountUsd: 10,
      amountMicrodollars: 10_000_000,
    });
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

  it('rejects a multi-unit purchase before it can be granted', async () => {
    const { verifyGooglePlayCreditPurchase } = loadVerifier();
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(productPurchase({ quantity: 3 }));

    // The refund handler refuses a quantity-based refund of a multi-quantity
    // order, so granting a three-pack would leave two permanently unrefundable.
    const rejection = verifyGooglePlayCreditPurchase({
      productId: 'credits_usd10',
      purchaseToken: 'purchase-token',
    });

    await expect(rejection).rejects.toBeInstanceOf(StoreVerificationError);
    await expect(rejection).rejects.toThrow('Google Play credit packs are sold one unit at a time');
  });

  it.each([0, 1.5, 101])('rejects the out-of-range quantity %s', async quantity => {
    const { verifyGooglePlayCreditPurchase } = loadVerifier();
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(productPurchase({ quantity }));

    await expect(
      verifyGooglePlayCreditPurchase({
        productId: 'credits_usd10',
        purchaseToken: 'purchase-token',
      })
    ).rejects.toThrow('Google Play credit packs are sold one unit at a time');
  });

  // The purchase token is a bearer credential, so it may never be the ledger or
  // lock identity; the digest is the only trace of it the purchase keeps.
  it('falls back to a non-reversible digest of the purchase token when the order id is absent', async () => {
    const { verifyGooglePlayCreditPurchase } = loadVerifier();
    mockGetGooglePlayProductPurchase.mockResolvedValueOnce(productPurchase({ orderId: null }));

    const result = await verifyGooglePlayCreditPurchase({
      productId: 'credits_usd10',
      purchaseToken: 'purchase-token',
    });

    expect(result.providerTransactionId).toBe(
      `token-sha256:${createHash('sha256').update('purchase-token').digest('hex')}`
    );
    expect(result.providerTransactionId).not.toContain('purchase-token');
    // The digest key is the ledger identity; the raw token stays available for
    // the refund-event lookup only.
    expect(result.googlePlayPurchaseToken).toBe('purchase-token');
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

describe('storeCreditRefundLookupProviderTransactionIds', () => {
  function googlePlayPurchase(
    overrides: Partial<StoreVerifier.ValidatedStoreCreditPurchase> = {}
  ): StoreVerifier.ValidatedStoreCreditPurchase {
    return {
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
      productId: 'credits_usd10',
      providerTransactionId: 'GPA.1234',
      appAccountToken: null,
      googlePlayPurchaseToken: null,
      quantity: 1,
      amountUsd: 10,
      amountMicrodollars: 10_000_000,
      purchasedAtIso: '2026-06-01T09:00:00.000Z',
      environment: 'Production',
      rawPayload: {},
      ...overrides,
    };
  }

  // The credit ledger and the advisory lock only ever see the digest, so the
  // raw token is handed to the refund-event lookup, which matches the token the
  // store-event table stores. The purchase response cannot be relied on to echo
  // the token, so it rides on the purchase explicitly.
  it('adds the raw purchase token for a digest-keyed grant', () => {
    const { storeCreditRefundLookupProviderTransactionIds } = loadVerifier();
    const digest = `token-sha256:${createHash('sha256').update('purchase-token').digest('hex')}`;

    expect(
      storeCreditRefundLookupProviderTransactionIds(
        googlePlayPurchase({
          providerTransactionId: digest,
          googlePlayPurchaseToken: 'purchase-token',
        })
      )
    ).toEqual([digest, 'purchase-token']);
  });

  it('keeps the ledger identity alone when no token is carried', () => {
    const { storeCreditRefundLookupProviderTransactionIds } = loadVerifier();

    expect(
      storeCreditRefundLookupProviderTransactionIds(
        googlePlayPurchase({
          paymentProvider: KiloPassPaymentProvider.AppStore,
          providerTransactionId: 'tx-1',
          googlePlayPurchaseToken: null,
        })
      )
    ).toEqual(['tx-1']);
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
