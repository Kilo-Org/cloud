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
  resetTerminalPurchaseRejections,
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
const STORE_PURCHASE_VERIFICATION_FAILED_MESSAGE =
  'We could not verify this store purchase. Please try again.';
const STORE_PURCHASE_REFUNDED_MESSAGE =
  'This store purchase has been refunded, so Kilo cannot credit it.';

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
    isAccountCurrent: () => true,
    requestPurchase: vi.fn().mockResolvedValue(null),
    showError: () => undefined,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPurchaseErrorToastDedup();
  resetInlinePurchaseErrorOwnership();
  resetTerminalPurchaseRejections();
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

  it('recovers the outstanding transaction when the store says the pack is already owned', async () => {
    const recoverOwnedPurchase = vi.fn().mockResolvedValue(true);
    const showError = vi.fn();
    const actions = createActions({
      requestPurchase: vi.fn().mockRejectedValue({
        code: 'already-owned',
        message: 'Item already owned',
      }),
      recoverOwnedPurchase,
      showError: message => {
        showError(message);
      },
    });

    expect(await actions.purchase(creditPack)).toBe(false);
    expect(recoverOwnedPurchase).toHaveBeenCalledTimes(1);
    // The recovery completed the purchase, so no failure is reported — and never
    // the different-account copy for a purchase the same user already made.
    expect(showError).not.toHaveBeenCalled();
  });

  it('reports a generic failure when the already-owned recovery finds nothing', async () => {
    const showError = vi.fn();
    const actions = createActions({
      requestPurchase: vi.fn().mockRejectedValue({
        code: 'already-owned',
        message: 'Item already owned',
      }),
      recoverOwnedPurchase: vi.fn().mockResolvedValue(false),
      showError: message => {
        showError(message);
      },
    });

    expect(await actions.purchase(creditPack)).toBe(false);
    expect(showError).toHaveBeenCalledWith(CREDIT_PURCHASE_FAILED_KEY);
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

  it('reports a granted purchase as completed when finishing the store transaction fails', async () => {
    const onPurchaseCompleted = vi.fn();
    const actions = createActions({
      finishTransaction: vi.fn().mockRejectedValue(new Error('StoreKit unavailable')),
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    // The backend already granted the credits, so a finish failure must not
    // read as a failed purchase: the store re-delivers the transaction and
    // recovery finishes it on the next launch.
    expect(await actions.handlePurchaseSuccess(createPurchase())).toBe(true);
    expect(onPurchaseCompleted).toHaveBeenCalledTimes(1);
  });

  it('reports a granted purchase as completed when the balance refresh fails', async () => {
    const onPurchaseCompleted = vi.fn();
    const actions = createActions({
      invalidateAfterCompletion: vi.fn().mockRejectedValue(new Error('offline')),
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    expect(await actions.handlePurchaseSuccess(createPurchase())).toBe(true);
    expect(onPurchaseCompleted).toHaveBeenCalledTimes(1);
  });

  it('announces a re-delivered transaction once while its completion is in flight', async () => {
    const purchase = createPurchase();
    const onPurchaseCompleted = vi.fn();
    const backendCompletionGate = Promise.withResolvers<undefined>();
    const completeAppStorePurchase = vi.fn().mockImplementation(async () => {
      await backendCompletionGate.promise;
      return { alreadyProcessed: false };
    });
    const actions = createActions({
      completeAppStorePurchase,
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    const firstDelivery = actions.handlePurchaseSuccess(purchase);
    // The store re-delivers the same transaction before the first backend
    // completion resolves; both deliveries await the same shared completion.
    const secondDelivery = actions.handlePurchaseSuccess(purchase);
    backendCompletionGate.resolve(undefined);

    await expect(firstDelivery).resolves.toBe(true);
    await expect(secondDelivery).resolves.toBe(true);

    expect(completeAppStorePurchase).toHaveBeenCalledTimes(1);
    expect(onPurchaseCompleted).toHaveBeenCalledTimes(1);
  });

  it('announces a live delivery that coalesces with the silent recovery pass', async () => {
    const purchase = createPurchase();
    const onPurchaseCompleted = vi.fn();
    const backendCompletionGate = Promise.withResolvers<undefined>();
    const completeAppStorePurchase = vi.fn().mockImplementation(async () => {
      await backendCompletionGate.promise;
      return { alreadyProcessed: false };
    });
    const actions = createActions({
      completeAppStorePurchase,
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    // The recovery pass starts the shared completion silently; the store then
    // delivers the same transaction live before it resolves. The live delivery
    // is that completion's first notifier, so it must still announce once.
    const recovery = actions.recoverPurchases([purchase]);
    const liveDelivery = actions.handlePurchaseSuccess(purchase);
    backendCompletionGate.resolve(undefined);

    await expect(recovery).resolves.toEqual([purchase]);
    await expect(liveDelivery).resolves.toBe(true);

    expect(completeAppStorePurchase).toHaveBeenCalledTimes(1);
    expect(onPurchaseCompleted).toHaveBeenCalledTimes(1);
  });

  it('does not announce when the recovery pass joins a live completion', async () => {
    const purchase = createPurchase();
    const onPurchaseCompleted = vi.fn();
    const backendCompletionGate = Promise.withResolvers<undefined>();
    const completeAppStorePurchase = vi.fn().mockImplementation(async () => {
      await backendCompletionGate.promise;
      return { alreadyProcessed: false };
    });
    const actions = createActions({
      completeAppStorePurchase,
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    const liveDelivery = actions.handlePurchaseSuccess(purchase);
    const recovery = actions.recoverPurchases([purchase]);
    backendCompletionGate.resolve(undefined);

    await expect(liveDelivery).resolves.toBe(true);
    await expect(recovery).resolves.toEqual([purchase]);

    expect(completeAppStorePurchase).toHaveBeenCalledTimes(1);
    expect(onPurchaseCompleted).toHaveBeenCalledTimes(1);
  });

  it('does not let another account join an unresolved completion', async () => {
    const purchase = createPurchase();
    const backendCompletionGate = Promise.withResolvers<undefined>();
    const completeForAccountA = vi.fn().mockImplementation(async () => {
      await backendCompletionGate.promise;
      return { alreadyProcessed: false };
    });
    // Account A is mid-completion when the account changes; the new account's
    // recovery finds the same transaction. It must submit its own request under
    // its own account token, not join A's and inherit its result.
    const completeForAccountB = vi
      .fn()
      .mockRejectedValue(new Error(STORE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_MESSAGE));
    const showErrorForAccountB = vi.fn();
    const actionsForAccountA = createActions({
      appAccountToken: 'account-a-token',
      completeAppStorePurchase: completeForAccountA,
    });
    const actionsForAccountB = createActions({
      appAccountToken: 'account-b-token',
      completeAppStorePurchase: completeForAccountB,
      showError: message => {
        showErrorForAccountB(message);
      },
    });

    const accountACompletion = actionsForAccountA.handlePurchaseSuccess(purchase);
    const accountBCompletion = actionsForAccountB.handlePurchaseSuccess(purchase);
    backendCompletionGate.resolve(undefined);

    await expect(accountACompletion).resolves.toBe(true);
    await expect(accountBCompletion).resolves.toBe(false);

    expect(completeForAccountA).toHaveBeenCalledTimes(1);
    expect(completeForAccountB).toHaveBeenCalledTimes(1);
    // B's own refusal is the explicit backend ownership refusal, so it is the
    // one that earns the different-account copy.
    expect(showErrorForAccountB).toHaveBeenCalledWith(CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_KEY);
  });

  it('shares a completion within one account', async () => {
    const purchase = createPurchase();
    const backendCompletionGate = Promise.withResolvers<undefined>();
    const completeAppStorePurchase = vi.fn().mockImplementation(async () => {
      await backendCompletionGate.promise;
      return { alreadyProcessed: false };
    });
    const actions = createActions({ appAccountToken: 'account-a-token', completeAppStorePurchase });

    const first = actions.handlePurchaseSuccess(purchase);
    const second = actions.handlePurchaseSuccess(purchase);
    backendCompletionGate.resolve(undefined);

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(completeAppStorePurchase).toHaveBeenCalledTimes(1);
  });

  it('announces a recovery the user triggered, unlike the background pass', async () => {
    const purchase = createPurchase();
    const onPurchaseCompleted = vi.fn();
    const actions = createActions({
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    await actions.recoverPurchases([purchase], { notifyCompletion: true });

    expect(onPurchaseCompleted).toHaveBeenCalledTimes(1);
  });

  it('does not post a receipt whose account is already gone', async () => {
    const completeAppStorePurchase = vi.fn();
    const showError = vi.fn();
    const actions = createActions({
      isAccountCurrent: () => false,
      completeAppStorePurchase,
      showError: message => {
        showError(message);
      },
    });

    expect(await actions.handlePurchaseSuccess(createPurchase())).toBe(false);
    expect(completeAppStorePurchase).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('does not post a second receipt after the account changed under the first', async () => {
    let signedInAccount = 'account-a';
    const backendGate = Promise.withResolvers<undefined>();
    const completeAppStorePurchase = vi.fn().mockImplementation(async () => {
      await backendGate.promise;
      return { alreadyProcessed: false };
    });
    const invalidateAfterCompletion = vi.fn();
    const actions = createActions({
      appAccountToken: 'account-a-token',
      isAccountCurrent: () => signedInAccount === 'account-a',
      completeAppStorePurchase,
      invalidateAfterCompletion,
    });

    const firstPass = actions.recoverPurchases([createPurchase({ transactionId: 'tx-1' })]);
    // The account changes while the first receipt's backend call is in flight.
    signedInAccount = 'account-b';

    // The second receipt is recovered by the same, now old, session: it must not
    // be posted under the new one.
    await expect(
      actions.recoverPurchases([createPurchase({ transactionId: 'tx-2' })])
    ).resolves.toEqual([]);
    expect(completeAppStorePurchase).toHaveBeenCalledTimes(1);

    // The first receipt's grant belongs to the old session: it is not reported
    // as recovered and does not refresh the new account's balance.
    backendGate.resolve(undefined);
    await expect(firstPass).resolves.toEqual([]);
    expect(invalidateAfterCompletion).not.toHaveBeenCalled();
  });

  it('does not announce or refresh when the account changes while the backend answers', async () => {
    let signedInAccount = 'account-a';
    const backendGate = Promise.withResolvers<undefined>();
    const completeAppStorePurchase = vi.fn().mockImplementation(async () => {
      await backendGate.promise;
      return { alreadyProcessed: false };
    });
    const finishTransaction = vi.fn().mockResolvedValue(undefined);
    const invalidateAfterCompletion = vi.fn();
    const onPurchaseCompleted = vi.fn();
    const actions = createActions({
      isAccountCurrent: () => signedInAccount === 'account-a',
      completeAppStorePurchase,
      finishTransaction,
      invalidateAfterCompletion,
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    const completion = actions.handlePurchaseSuccess(createPurchase());
    signedInAccount = 'account-b';
    backendGate.resolve(undefined);

    await expect(completion).resolves.toBe(true);
    expect(onPurchaseCompleted).not.toHaveBeenCalled();
    expect(invalidateAfterCompletion).not.toHaveBeenCalled();
    // The store transaction is still finished: the store holds it for this
    // device whatever Kilo account is signed in, and leaving it queued would
    // only re-deliver it.
    expect(finishTransaction).toHaveBeenCalledTimes(1);
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

  it('does not map a store AlreadyOwned error to the different-account key', () => {
    // A consumable the store still owns is usually this same user's unfinished
    // charge, so the different-account copy is reserved for the backend's own
    // ownership refusal (below).
    expect(
      getStoreCreditPurchaseErrorMessageKey(
        { code: 'already-owned', message: 'Item already owned' },
        'play'
      )
    ).toBe(CREDIT_PURCHASE_FAILED_KEY);
    expect(
      getStoreCreditPurchaseErrorMessageKey(
        { code: 'already-owned', message: 'Item already owned' },
        'app_store'
      )
    ).toBe(CREDIT_PURCHASE_FAILED_KEY);
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

  it('reposts a wrong-account refusal, so the owning account can complete it', async () => {
    const purchase = createPurchase();
    const completeAppStorePurchase = vi
      .fn()
      .mockRejectedValueOnce({
        data: { code: 'FORBIDDEN', message: APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE },
      })
      .mockResolvedValue({ alreadyProcessed: false });
    const finishTransaction = vi.fn();
    const showError = vi.fn();
    const actions = createActions({
      completeAppStorePurchase,
      finishTransaction,
      showError: message => {
        showError(message);
      },
    });

    expect(await actions.recoverPurchases([purchase])).toEqual([]);
    expect(finishTransaction).not.toHaveBeenCalled();
    // Background recovery is silent: the purchase stays in the store queue.
    expect(showError).not.toHaveBeenCalled();

    // Another account refused this receipt, which is not a defect in it: the
    // account that owns it still signs in and completes the same purchase.
    expect(await actions.recoverPurchases([purchase])).toEqual([purchase]);
    expect(completeAppStorePurchase).toHaveBeenCalledTimes(2);
    expect(finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: true });
  });

  it.each([STORE_PURCHASE_VERIFICATION_FAILED_MESSAGE, STORE_PURCHASE_REFUNDED_MESSAGE])(
    'does not post the receipt the backend refused with %s a second time',
    async message => {
      const purchase = createPurchase();
      const completeAppStorePurchase = vi
        .fn()
        .mockRejectedValue({ data: { code: 'BAD_REQUEST', message } });
      const actions = createActions({ completeAppStorePurchase });

      expect(await actions.recoverPurchases([purchase])).toEqual([]);
      expect(await actions.recoverPurchases([purchase])).toEqual([]);
      expect(completeAppStorePurchase).toHaveBeenCalledTimes(1);
    }
  );

  it('retries after a session error, which is not about the receipt', async () => {
    const purchase = createPurchase();
    const completeAppStorePurchase = vi
      .fn()
      .mockRejectedValueOnce({ data: { code: 'UNAUTHORIZED', message: 'Not signed in' } })
      .mockResolvedValue({ alreadyProcessed: false });
    const actions = createActions({ completeAppStorePurchase });

    expect(await actions.recoverPurchases([purchase])).toEqual([]);
    expect(await actions.recoverPurchases([purchase])).toEqual([purchase]);
    expect(completeAppStorePurchase).toHaveBeenCalledTimes(2);
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
