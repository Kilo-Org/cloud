/**
 * @jest-environment node
 */
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as Sentry from '@sentry/nextjs';

import { DrizzleQueryError } from 'drizzle-orm';

import type { ValidatedStoreCreditPurchase } from '@/lib/credits/store-verifier';
import { STORE_CREDIT_PRODUCTS } from '@/lib/credits/store-products';
import {
  StoreCreditPurchaseOwnedByAnotherAccountError,
  StorePurchasePendingError,
  StoreVerificationError,
} from '@/lib/credits/store-purchase-errors';
import { KiloPassPaymentProvider } from '@kilocode/web-shared/lib/kilo-pass/enums';
import { APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE } from '@/lib/credits/store-account-token';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';

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

// The mobile clients match this exact backend string, so it is pinned here
// rather than imported from the constant it is produced from.
const STORE_PURCHASE_REFUNDED_MESSAGE =
  'This store purchase has been refunded, so Kilo cannot credit it.';

// Pinned for the same reason: the mobile client matches this exact message (and
// must treat it as retryable) rather than the terminal receipt refusal.
const STORE_PURCHASE_PENDING_MESSAGE = 'This Google Play purchase is still pending.';

function captureExceptionMock() {
  return jest.mocked(jest.requireMock<typeof Sentry>('@sentry/nextjs').captureException);
}

let createCaller: Awaited<ReturnType<typeof buildCallerFactory>>;

async function buildCallerFactory() {
  const [{ creditsRouter }, { createCallerFactory }] = await Promise.all([
    import('@/routers/credits-router'),
    import('@kilocode/web-shared/lib/trpc/init'),
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

/**
 * Everything Sentry would serialize off the captured value, cause chain
 * included. `JSON.stringify` alone sees none of an Error's message or stack.
 */
function captureText(captured: unknown): string {
  let text = `${JSON.stringify(captured)} `;
  let current: unknown = captured;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    text += `${current.name}: ${current.message}\n${current.stack ?? ''}\n`;
    current = current.cause;
  }
  return text;
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
      new StoreCreditPurchaseOwnedByAnotherAccountError()
    );

    await expect(
      callerForUser().completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reports a terminal verification failure as non-retryable', async () => {
    mockVerifyAppleCreditPurchase.mockRejectedValue(
      new StoreVerificationError('Apple transaction is missing identifiers')
    );

    await expect(
      callerForUser().completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  // Only the error type decides terminal versus retryable: a failure that
  // merely reads like a store refusal must stay retryable, or the mobile client
  // records the purchase as terminally rejected and stops recovering a charge
  // the user already paid for.
  it('keeps a transient database failure retryable when its SQL names credit_transactions', async () => {
    mockCompleteStoreCreditPurchase.mockRejectedValue(
      new DrizzleQueryError(
        'insert into "credit_transactions" ("id", "stripe_payment_id") values ($1, $2)',
        ['tx-1', 'store-credit:app_store:tx-1'],
        new Error('deadlock detected')
      )
    );

    await expect(
      callerForUser().completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('keeps a provider failure that names a product retryable', async () => {
    mockVerifyAppleCreditPurchase.mockRejectedValue(
      new Error('product lookup failed at the store')
    );

    await expect(
      callerForUser().completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('never reports the signed transaction it was given', async () => {
    mockCompleteStoreCreditPurchase.mockRejectedValue(
      new Error('Failed query: select 1 from credit_transactions\nparams: signed-jws')
    );

    await expect(
      callerForUser().completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

    expect(captureText(captureExceptionMock().mock.calls[0]?.[0])).not.toContain('signed-jws');
  });

  it('reports a refunded purchase as terminal and does not report it as an incident', async () => {
    mockCompleteStoreCreditPurchase.mockRejectedValue(new Error(STORE_PURCHASE_REFUNDED_MESSAGE));

    await expect(
      callerForUser().completeAppStorePurchase({ signedTransactionJws: 'signed-jws' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: STORE_PURCHASE_REFUNDED_MESSAGE,
    });
    expect(captureExceptionMock()).not.toHaveBeenCalled();
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

  // Play has accepted the charge but not finished it; the same token verifies
  // once it does. Classifying this as the terminal receipt refusal would make
  // the mobile client remember the purchase for the process and never recover a
  // charge that is approved a moment later.
  it('reports a pending purchase as retryable and never grants or consumes it', async () => {
    mockVerifyGooglePlayCreditPurchase.mockRejectedValue(
      new StorePurchasePendingError(STORE_PURCHASE_PENDING_MESSAGE)
    );

    await expect(
      callerForUser().completePlayPurchase({
        productId: 'credits_usd10',
        purchaseToken: 'play-purchase-token',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: STORE_PURCHASE_PENDING_MESSAGE,
    });
    expect(mockCompleteStoreCreditPurchase).not.toHaveBeenCalled();
    expect(mockAcknowledgeGooglePlayCreditPurchase).not.toHaveBeenCalled();
    // A purchase that is merely pending is an expected outcome, not an incident.
    expect(captureExceptionMock()).not.toHaveBeenCalled();
  });

  it('surfaces a completion that belongs to another user as non-retryable', async () => {
    mockCompleteStoreCreditPurchase.mockRejectedValue(
      new StoreCreditPurchaseOwnedByAnotherAccountError()
    );

    await expect(
      callerForUser().completePlayPurchase({
        productId: 'credits_usd10',
        purchaseToken: 'play-purchase-token',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockAcknowledgeGooglePlayCreditPurchase).not.toHaveBeenCalled();
  });

  // A failed query quotes the parameters it was built from, and the purchase
  // token is a bearer credential, so it may not reach Sentry.
  it('never reports the purchase token of a failed grant', async () => {
    mockCompleteStoreCreditPurchase.mockRejectedValue(
      new DrizzleQueryError(
        'insert into "credit_transactions" ("id", "stripe_payment_id") values ($1, $2)',
        ['tx-1', 'store-credit:google_play:play-purchase-token'],
        new Error('play-purchase-token was rejected')
      )
    );

    await expect(
      callerForUser().completePlayPurchase({
        productId: 'credits_usd10',
        purchaseToken: 'play-purchase-token',
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

    const captured = captureExceptionMock().mock.calls[0]?.[0];
    expect(captured).toBeInstanceOf(Error);
    expect(captureText(captured)).not.toContain('play-purchase-token');
  });

  it('never reports the purchase token of a failed consume', async () => {
    mockAcknowledgeGooglePlayCreditPurchase.mockRejectedValue(
      new Error('Request failed for /tokens/play-purchase-token')
    );

    await expect(
      callerForUser().completePlayPurchase({
        productId: 'credits_usd10',
        purchaseToken: 'play-purchase-token',
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

    expect(captureText(captureExceptionMock().mock.calls[0]?.[0])).not.toContain(
      'play-purchase-token'
    );
  });

  it('reports a refunded purchase as terminal and never consumes it', async () => {
    mockCompleteStoreCreditPurchase.mockRejectedValue(new Error(STORE_PURCHASE_REFUNDED_MESSAGE));

    await expect(
      callerForUser().completePlayPurchase({
        productId: 'credits_usd10',
        purchaseToken: 'play-purchase-token',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: STORE_PURCHASE_REFUNDED_MESSAGE,
    });
    expect(mockAcknowledgeGooglePlayCreditPurchase).not.toHaveBeenCalled();
  });
});
