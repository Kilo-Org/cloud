/* eslint-disable max-lines -- One suite pins the whole store purchase lifecycle: request shapes, completion order, error mapping and recovery. */

import { type Purchase } from 'expo-iap';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type StoreCreditProduct } from './store-products';
import {
  createStoreCreditPurchaseActions,
  CREDIT_PURCHASE_FAILED_KEY,
  CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_KEY,
  CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_PLAY_KEY,
  getStoreCreditPurchaseErrorMessageKey,
  isRecoverableCreditPurchase,
  resetInlinePurchaseErrorOwnership,
  resetPurchaseErrorToastDedup,
} from './use-store-credit-purchase';

vi.mock('expo-iap', () => ({
  ErrorCode: {
    AlreadyOwned: 'already-owned',
    BillingUnavailable: 'billing-unavailable',
    UserCancelled: 'user-cancelled',
  },
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE =
  'App Store purchase account token does not match the signed-in user.';
const GOOGLE_PLAY_ACCOUNT_TOKEN_MISMATCH_MESSAGE =
  'Google Play purchase account token does not match the signed-in user.';
const STORE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_MESSAGE =
  'This purchase is already linked to another Kilo account.';

const APPLE_PRODUCT_ID = 'credits.usd10.v1';
const GOOGLE_PRODUCT_ID = 'credits_usd10';
const APP_ACCOUNT_TOKEN = '550e8400-e29b-41d4-a716-446655440000';

const creditPack: StoreCreditProduct = {
  backend: {
    amountUsd: 10,
    appleProductId: APPLE_PRODUCT_ID,
    googleProductId: GOOGLE_PRODUCT_ID,
  },
  storeProductId: APPLE_PRODUCT_ID,
  displayPrice: '$10.99',
};

function createPurchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: 'purchase-1',
    ids: null,
    isAutoRenewing: false,
    productId: APPLE_PRODUCT_ID,
    purchaseState: 'purchased',
    purchaseToken: 'signed-jws',
    quantity: 1,
    store: 'apple',
    transactionDate: Date.now(),
    transactionId: 'tx-1',
    ...overrides,
  };
}

function createActions(
  overrides: Partial<Parameters<typeof createStoreCreditPurchaseActions>[0]> = {}
) {
  return createStoreCreditPurchaseActions({
    storefront: 'app_store',
    appAccountToken: APP_ACCOUNT_TOKEN,
    creditPackAppleProductIds: [APPLE_PRODUCT_ID],
    creditPackGoogleProductIds: [GOOGLE_PRODUCT_ID],
    completeAppStorePurchase: vi.fn().mockResolvedValue({ alreadyProcessed: false }),
    completePlayPurchase: vi.fn().mockResolvedValue({ alreadyProcessed: false }),
    finishTransaction: vi.fn().mockResolvedValue(undefined),
    invalidateAfterCompletion: vi.fn(),
    requestPurchase: vi.fn().mockResolvedValue(null),
    showError: () => undefined,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPurchaseErrorToastDedup();
  resetInlinePurchaseErrorOwnership();
});

describe('createStoreCreditPurchaseActions.purchase', () => {
  it('requests an App Store in-app purchase with the account token', async () => {
    const requestPurchase = vi.fn().mockResolvedValue(null);
    const actions = createActions({ requestPurchase });

    const started = await actions.purchase(creditPack);

    expect(started).toBe(true);
    expect(requestPurchase).toHaveBeenCalledWith({
      request: {
        apple: { appAccountToken: APP_ACCOUNT_TOKEN, sku: APPLE_PRODUCT_ID },
      },
      type: 'in-app',
    });
  });

  it('requests a Google Play in-app purchase with the obfuscated account id', async () => {
    const requestPurchase = vi.fn().mockResolvedValue(null);
    const actions = createActions({ storefront: 'play', requestPurchase });

    const started = await actions.purchase({ ...creditPack, storeProductId: GOOGLE_PRODUCT_ID });

    expect(started).toBe(true);
    expect(requestPurchase).toHaveBeenCalledWith({
      request: {
        google: {
          obfuscatedAccountId: APP_ACCOUNT_TOKEN,
          skus: [GOOGLE_PRODUCT_ID],
        },
      },
      type: 'in-app',
    });
  });

  it('does not request a purchase for a pack the store did not price', async () => {
    const requestPurchase = vi.fn();
    const actions = createActions({ requestPurchase });

    expect(await actions.purchase({ ...creditPack, storeProductId: null })).toBe(false);
    expect(requestPurchase).not.toHaveBeenCalled();
  });

  it('does not show an error when the user cancels the store sheet', async () => {
    const showError = vi.fn();
    const actions = createActions({
      requestPurchase: vi.fn().mockRejectedValue({
        code: 'user-cancelled',
        message: 'User cancelled the purchase',
      }),
      showError: message => {
        showError(message);
      },
    });

    expect(await actions.purchase(creditPack)).toBe(false);
    expect(showError).not.toHaveBeenCalled();
  });
});

describe('createStoreCreditPurchaseActions completion', () => {
  it('completes an iOS purchase with the signed transaction JWS and then finishes it', async () => {
    const purchase = createPurchase();
    const completeAppStorePurchase = vi.fn().mockResolvedValue({ alreadyProcessed: false });
    const finishTransaction = vi.fn().mockResolvedValue(undefined);
    const invalidateAfterCompletion = vi.fn();
    const actions = createActions({
      completeAppStorePurchase,
      finishTransaction,
      invalidateAfterCompletion,
    });

    expect(await actions.handlePurchaseSuccess(purchase)).toBe(true);

    expect(completeAppStorePurchase).toHaveBeenCalledWith({ signedTransactionJws: 'signed-jws' });
    expect(finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: true });
    expect(invalidateAfterCompletion).toHaveBeenCalledTimes(1);
  });

  it('completes an Android purchase with productId and purchaseToken', async () => {
    const purchase = createPurchase({
      store: 'google',
      productId: GOOGLE_PRODUCT_ID,
      purchaseToken: 'play-token',
    });
    const completePlayPurchase = vi.fn().mockResolvedValue({ alreadyProcessed: false });
    const finishTransaction = vi.fn().mockResolvedValue(undefined);
    const actions = createActions({
      storefront: 'play',
      completePlayPurchase,
      finishTransaction,
    });

    expect(await actions.handlePurchaseSuccess(purchase)).toBe(true);

    expect(completePlayPurchase).toHaveBeenCalledWith({
      productId: GOOGLE_PRODUCT_ID,
      purchaseToken: 'play-token',
    });
    expect(finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: true });
  });

  it('does not finish the transaction when backend completion fails', async () => {
    const finishTransaction = vi.fn();
    const showError = vi.fn();
    const actions = createActions({
      completeAppStorePurchase: vi.fn().mockRejectedValue(new Error('backend failed')),
      finishTransaction,
      showError: message => {
        showError(message);
      },
    });

    expect(await actions.handlePurchaseSuccess(createPurchase())).toBe(false);

    expect(finishTransaction).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(CREDIT_PURCHASE_FAILED_KEY);
  });

  it('reports a missing signed transaction without completing', async () => {
    const completeAppStorePurchase = vi.fn();
    const finishTransaction = vi.fn();
    const showError = vi.fn();
    const actions = createActions({
      completeAppStorePurchase,
      finishTransaction,
      showError: message => {
        showError(message);
      },
    });

    expect(await actions.handlePurchaseSuccess(createPurchase({ purchaseToken: null }))).toBe(
      false
    );

    expect(completeAppStorePurchase).not.toHaveBeenCalled();
    expect(finishTransaction).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith('kiloPass.purchaseMissingSignedTransaction');
  });
});

describe('getStoreCreditPurchaseErrorMessageKey', () => {
  it('maps a store-side user cancellation to null', () => {
    expect(
      getStoreCreditPurchaseErrorMessageKey(
        { code: 'user-cancelled', message: 'User cancelled' },
        'app_store'
      )
    ).toBeNull();
  });

  it('maps an App Store account mismatch to the credit-pack key', () => {
    expect(
      getStoreCreditPurchaseErrorMessageKey(
        new Error(APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE),
        'app_store'
      )
    ).toBe(CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_KEY);
  });

  it('maps a Play account mismatch to the Play credit-pack key', () => {
    expect(
      getStoreCreditPurchaseErrorMessageKey(
        new Error(GOOGLE_PLAY_ACCOUNT_TOKEN_MISMATCH_MESSAGE),
        'play'
      )
    ).toBe(CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_PLAY_KEY);
  });

  it('maps an already-credited store transaction to the owned-by-another-account key', () => {
    expect(
      getStoreCreditPurchaseErrorMessageKey(
        new Error(STORE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_MESSAGE),
        'app_store'
      )
    ).toBe(CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_KEY);
  });

  it('maps a store AlreadyOwned error to the storefront account key', () => {
    expect(
      getStoreCreditPurchaseErrorMessageKey(
        { code: 'already-owned', message: 'Item already owned' },
        'play'
      )
    ).toBe(CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_PLAY_KEY);
    expect(
      getStoreCreditPurchaseErrorMessageKey(
        { code: 'already-owned', message: 'Item already owned' },
        'app_store'
      )
    ).toBe(CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_KEY);
  });

  it('maps an unknown failure to the generic purchase-failed key', () => {
    expect(getStoreCreditPurchaseErrorMessageKey(new Error('StoreKit failed'), 'app_store')).toBe(
      CREDIT_PURCHASE_FAILED_KEY
    );
  });

  it('surfaces the Play account-mismatch key on an Android completion failure', async () => {
    const showError = vi.fn();
    const actions = createActions({
      storefront: 'play',
      completePlayPurchase: vi
        .fn()
        .mockRejectedValue(new Error(GOOGLE_PLAY_ACCOUNT_TOKEN_MISMATCH_MESSAGE)),
      showError: message => {
        showError(message);
      },
    });

    await actions.handlePurchaseSuccess(
      createPurchase({ store: 'google', productId: GOOGLE_PRODUCT_ID })
    );

    expect(showError).toHaveBeenCalledWith(CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_PLAY_KEY);
  });
});

describe('isRecoverableCreditPurchase', () => {
  it('matches only unfinished credit-pack transactions', () => {
    expect(
      isRecoverableCreditPurchase(createPurchase(), [APPLE_PRODUCT_ID], [GOOGLE_PRODUCT_ID])
    ).toBe(true);
    expect(
      isRecoverableCreditPurchase(
        createPurchase({ productId: 'other.product' }),
        [APPLE_PRODUCT_ID],
        [GOOGLE_PRODUCT_ID]
      )
    ).toBe(false);
    expect(
      isRecoverableCreditPurchase(
        createPurchase({ purchaseState: 'pending' }),
        [APPLE_PRODUCT_ID],
        [GOOGLE_PRODUCT_ID]
      )
    ).toBe(false);
  });
});

describe('createStoreCreditPurchaseActions.recoverPurchases', () => {
  it('completes an unfinished credit purchase once and never twice', async () => {
    const purchase = createPurchase();
    const completeAppStorePurchase = vi.fn().mockResolvedValue({ alreadyProcessed: false });
    const finishTransaction = vi.fn().mockResolvedValue(undefined);
    const invalidateAfterCompletion = vi.fn();
    const actions = createActions({
      completeAppStorePurchase,
      finishTransaction,
      invalidateAfterCompletion,
    });

    const recovered = await actions.recoverPurchases([
      purchase,
      // The same store transaction listed twice must not be completed twice.
      { ...purchase },
      createPurchase({ productId: 'other.product', transactionId: 'other-tx' }),
      createPurchase({ purchaseState: 'pending', transactionId: 'pending-tx' }),
    ]);

    expect(recovered).toEqual([purchase]);
    expect(completeAppStorePurchase).toHaveBeenCalledTimes(1);
    expect(finishTransaction).toHaveBeenCalledTimes(1);
    expect(finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: true });
    expect(invalidateAfterCompletion).toHaveBeenCalledTimes(1);
  });

  it('leaves a purchase the backend refuses as another account unfinished', async () => {
    const purchase = createPurchase();
    const completeAppStorePurchase = vi
      .fn()
      .mockRejectedValue(new Error(APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE));
    const finishTransaction = vi.fn();
    const showError = vi.fn();
    const actions = createActions({
      completeAppStorePurchase,
      finishTransaction,
      showError: message => {
        showError(message);
      },
    });

    const recovered = await actions.recoverPurchases([purchase]);

    expect(recovered).toEqual([]);
    expect(finishTransaction).not.toHaveBeenCalled();
    // Background recovery is silent: the purchase stays in the store queue.
    expect(showError).not.toHaveBeenCalled();
  });

  it('matches backend catalog ids, not the store-fetched list', async () => {
    const purchase = createPurchase({ productId: APPLE_PRODUCT_ID });
    const completeAppStorePurchase = vi.fn().mockResolvedValue({ alreadyProcessed: true });
    const actions = createActions({ completeAppStorePurchase });

    await actions.recoverPurchases([purchase], {
      creditPackAppleProductIds: [APPLE_PRODUCT_ID],
      creditPackGoogleProductIds: [],
    });

    expect(completeAppStorePurchase).toHaveBeenCalledTimes(1);
  });
});
