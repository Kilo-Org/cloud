/**
 * @jest-environment node
 */
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as Sentry from '@sentry/nextjs';

import type { ValidatedStoreCreditPurchase } from '@/lib/credits/store-verifier';
import { STORE_CREDIT_PRODUCTS } from '@/lib/credits/store-products';
import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';
import { APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE } from '@/lib/credits/store-account-token';
import type { TRPCContext } from '@/lib/trpc/init';

// @swc/jest does not hoist `jest.mock` when `jest` comes from '@jest/globals',
// so the router is imported lazily in `beforeAll`: the registration below must
// run before the router pulls its dependencies in. Every factory delegates
// lazily through an arrow closure, so it never reads the const bindings while
// the mock is registered.
const mockVerifyAppleCreditPurchase =
  jest.fn<(...args: unknown[]) => Promise<ValidatedStoreCreditPurchase>>();
const mockVerifyGooglePlayCreditPurchase =
  jest.fn<(...args: unknown[]) => Promise<ValidatedStoreCreditPurchase>>();
const mockAcknowledgeGooglePlayCreditPurchase = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockCompleteStoreCreditPurchase = jest.fn<
  (...args: unknown[]) => Promise<{
    alreadyProcessed: boolean;
    amountUsd: number;
    amountMicrodollars: number;
    creditTransactionId: string | null;
  }>
>();

jest.mock('@/lib/credits/store-verifier', () => ({
  verifyAppleCreditPurchase: (...args: unknown[]) => mockVerifyAppleCreditPurchase(...args),
  verifyGooglePlayCreditPurchase: (...args: unknown[]) =>
    mockVerifyGooglePlayCreditPurchase(...args),
  acknowledgeGooglePlayCreditPurchase: (...args: unknown[]) =>
    mockAcknowledgeGooglePlayCreditPurchase(...args),
}));

jest.mock('@/lib/credits/store-completion', () => ({
  completeStoreCreditPurchase: (...args: unknown[]) => mockCompleteStoreCreditPurchase(...args),
}));

jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<typeof Sentry>('@sentry/nextjs'),
  captureException: jest.fn(),
}));

const USER_ID = 'user-1';
const ACCOUNT_TOKEN = 'account-token-1';

let createCaller: Awaited<ReturnType<typeof buildCallerFactory>>;

async function buildCallerFactory() {
  const [{ creditsRouter }, { createCallerFactory }] = await Promise.all([
    import('@/routers/credits-router'),
    import('@/lib/trpc/init'),
  ]);
  return createCallerFactory(creditsRouter);
}

function callerForUser(appStoreAccountToken: string = ACCOUNT_TOKEN) {
  const ctx = {
    user: { id: USER_ID, app_store_account_token: appStoreAccountToken },
  } as unknown as TRPCContext;
  return createCaller(ctx);
}

function storePurchase(
  overrides: Partial<ValidatedStoreCreditPurchase> = {}
): ValidatedStoreCreditPurchase {
  return {
    paymentProvider: KiloPassPaymentProvider.AppStore,
    productId: 'credits.usd10.v1',
    providerTransactionId: 'tx-1',
    appAccountToken: ACCOUNT_TOKEN,
    quantity: 1,
    amountUsd: 10,
    amountMicrodollars: 10_000_000,
    purchasedAtIso: '2026-06-01T09:00:00.000Z',
    environment: 'Sandbox',
    rawPayload: {},
    ...overrides,
  };
}

function granted(amountUsd: number, alreadyProcessed = false) {
  return {
    alreadyProcessed,
    amountUsd,
    amountMicrodollars: amountUsd * 1_000_000,
    creditTransactionId: 'credit-transaction-1',
  };
}

beforeAll(async () => {
  createCaller = await buildCallerFactory();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyAppleCreditPurchase.mockResolvedValue(storePurchase());
  mockVerifyGooglePlayCreditPurchase.mockResolvedValue(
    storePurchase({
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
      productId: 'credits_usd10',
      providerTransactionId: 'GPA.1234',
    })
  );
  mockAcknowledgeGooglePlayCreditPurchase.mockResolvedValue(undefined);
  mockCompleteStoreCreditPurchase.mockResolvedValue(granted(10));
});

describe('creditsRouter.getMobileStoreProducts', () => {
  it('returns the signed-in user token and the catalog packs in order', async () => {
    const result = await callerForUser().getMobileStoreProducts();

    expect(result.appAccountToken).toBe(ACCOUNT_TOKEN);
    expect(result.products).toEqual(
      STORE_CREDIT_PRODUCTS.map(product => ({
        amountUsd: product.amountUsd,
        appleProductId: product.appleProductId,
        googleProductId: product.googleProductId,
      }))
    );
    expect(result.products.map(product => product.amountUsd)).toEqual([10, 50, 100, 500]);
  });
});

describe('creditsRouter.completeAppStorePurchase', () => {
  it('validates the JWS, passes the purchase to the completion, and returns its amount', async () => {
    const purchase = storePurchase();
    mockVerifyAppleCreditPurchase.mockResolvedValue(purchase);
    mockCompleteStoreCreditPurchase.mockResolvedValue(granted(10, true));

    const result = await callerForUser().completeAppStorePurchase({
      signedTransactionJws: 'signed-jws',
    });

    expect(mockVerifyAppleCreditPurchase).toHaveBeenCalledWith('signed-jws');
    expect(mockCompleteStoreCreditPurchase).toHaveBeenCalledWith({
      user: { id: USER_ID, app_store_account_token: ACCOUNT_TOKEN },
      purchase,
    });
    expect(result).toEqual({ amountUsd: 10, alreadyProcessed: true });
  });

  it('throws FORBIDDEN on a token mismatch and never calls the completion', async () => {
    mockVerifyAppleCreditPurchase.mockResolvedValue(
      storePurchase({ appAccountToken: 'some-other-token' })
    );

    await expect(
      callerForUser().completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE,
    });
    expect(mockCompleteStoreCreditPurchase).not.toHaveBeenCalled();
  });

  it('surfaces a completion that belongs to another user as non-retryable', async () => {
    mockCompleteStoreCreditPurchase.mockRejectedValue(
      new Error('Store transaction already belongs to another user')
    );

    await expect(
      callerForUser().completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reports a terminal verification failure as non-retryable', async () => {
    mockVerifyAppleCreditPurchase.mockRejectedValue(
      new Error('Apple transaction is missing identifiers')
    );

    await expect(
      callerForUser().completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('maps a store or API failure to a retryable internal error', async () => {
    mockVerifyAppleCreditPurchase.mockRejectedValue(new Error('provider unavailable'));

    await expect(
      callerForUser().completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});

describe('creditsRouter.completePlayPurchase', () => {
  it('validates the token, grants the credit, then consumes the purchase', async () => {
    const result = await callerForUser().completePlayPurchase({
      productId: 'credits_usd10',
      purchaseToken: 'play-purchase-token',
    });

    expect(mockVerifyGooglePlayCreditPurchase).toHaveBeenCalledWith({
      productId: 'credits_usd10',
      purchaseToken: 'play-purchase-token',
    });
    expect(mockCompleteStoreCreditPurchase).toHaveBeenCalledWith({
      user: { id: USER_ID, app_store_account_token: ACCOUNT_TOKEN },
      purchase: expect.objectContaining({ productId: 'credits_usd10' }),
    });
    expect(result).toEqual({ amountUsd: 10, alreadyProcessed: false });

    // The grant must land before the consume, so an interrupted flow can retry
    // with the same token instead of losing a paid purchase.
    const grantOrder = mockCompleteStoreCreditPurchase.mock.invocationCallOrder[0];
    const consumeOrder = mockAcknowledgeGooglePlayCreditPurchase.mock.invocationCallOrder[0];
    expect(grantOrder).toBeLessThan(consumeOrder);
    expect(mockAcknowledgeGooglePlayCreditPurchase).toHaveBeenCalledWith(
      'credits_usd10',
      'play-purchase-token'
    );
  });

  it('throws FORBIDDEN on a token mismatch and never grants or consumes', async () => {
    mockVerifyGooglePlayCreditPurchase.mockResolvedValue(
      storePurchase({
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        productId: 'credits_usd10',
        appAccountToken: 'some-other-token',
      })
    );

    await expect(
      callerForUser().completePlayPurchase({
        productId: 'credits_usd10',
        purchaseToken: 'play-purchase-token',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockCompleteStoreCreditPurchase).not.toHaveBeenCalled();
    expect(mockAcknowledgeGooglePlayCreditPurchase).not.toHaveBeenCalled();
  });

  it('reports a failed consume as retryable without losing the grant', async () => {
    mockAcknowledgeGooglePlayCreditPurchase.mockRejectedValue(new Error('consume failed'));

    await expect(
      callerForUser().completePlayPurchase({
        productId: 'credits_usd10',
        purchaseToken: 'play-purchase-token',
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(mockCompleteStoreCreditPurchase).toHaveBeenCalledTimes(1);
  });

  it('surfaces a completion that belongs to another user as non-retryable', async () => {
    mockCompleteStoreCreditPurchase.mockRejectedValue(
      new Error('Store transaction already belongs to another user')
    );

    await expect(
      callerForUser().completePlayPurchase({
        productId: 'credits_usd10',
        purchaseToken: 'play-purchase-token',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockAcknowledgeGooglePlayCreditPurchase).not.toHaveBeenCalled();
  });
});
