/* eslint-disable max-lines */

import { type Purchase } from 'expo-iap';
import { describe, expect, it, vi } from 'vitest';
import { createAppStoreKiloPassPurchaseActions } from './use-store-kilo-pass-purchase';
import { type AppStoreKiloPassProduct } from './store-products';

vi.mock('expo-iap', () => ({
  ErrorCode: {
    AlreadyOwned: 'already-owned',
    UserCancelled: 'user-cancelled',
  },
  useIAP: () => ({
    availablePurchases: [],
    connected: false,
    finishTransaction: vi.fn(),
    getAvailablePurchases: vi.fn(),
    requestPurchase: vi.fn(),
  }),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    kiloPass: {
      completeAppStorePurchase: { mutationOptions: () => ({}) },
      getCreditHistory: { pathFilter: () => ({ queryKey: ['credit-history'] }) },
      getState: { pathFilter: () => ({ queryKey: ['state'] }) },
    },
    user: {
      getContextBalance: { pathFilter: () => ({ queryKey: ['balance'] }) },
      getCreditBlocks: { pathFilter: () => ({ queryKey: ['credits'] }) },
    },
  }),
}));

function ignoreDeferredResolution(_value: unknown) {
  return undefined;
}

const product: AppStoreKiloPassProduct = {
  appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
  appleProductId: 'com.kilo.pass.tier19.monthly',
  cadence: 'monthly',
  description: 'Kilo Pass',
  displayPrice: '$24.99',
  googleBasePlanId: 'monthly-v1',
  googleProductId: 'kilopass_tier19',
  storeProduct: {
    id: 'com.kilo.pass.tier19.monthly',
    displayPrice: '$24.99',
    title: 'Kilo Pass',
    description: 'Kilo Pass',
  },
  suggestedStoreMonthlyPriceUsd: 24.7,
  tier: 'tier_19',
  title: 'Kilo Pass',
  webMonthlyPriceUsd: 19,
};

function noop() {
  return undefined;
}

function createActions(
  overrides: Partial<Parameters<typeof createAppStoreKiloPassPurchaseActions>[0]> = {}
) {
  return createAppStoreKiloPassPurchaseActions({
    completeAppStorePurchase: vi.fn(),
    enabledAppleProductIds: [product.appleProductId],
    finishTransaction: vi.fn(),
    invalidateAfterCompletion: vi.fn(),
    requestPurchase: vi.fn(),
    showError: () => undefined,
    ...overrides,
  });
}

function createDeferredPromise() {
  let resolvePromise: (value: unknown) => void = ignoreDeferredResolution;
  const promise = new Promise(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createPurchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: 'purchase-1',
    ids: null,
    isAutoRenewing: true,
    platform: 'ios',
    productId: product.appleProductId,
    purchaseState: 'purchased',
    purchaseToken: 'signed-jws',
    quantity: 1,
    store: 'apple',
    transactionDate: Date.now(),
    transactionId: 'tx-1',
    ...overrides,
  };
}

describe('createAppStoreKiloPassPurchaseActions', () => {
  it('requests an App Store subscription purchase', async () => {
    const requestPurchase = vi.fn().mockResolvedValue(null);
    const actions = createActions({
      requestPurchase,
    });

    await actions.purchase(product);

    expect(requestPurchase).toHaveBeenCalledWith({
      request: { apple: { appAccountToken: product.appAccountToken, sku: product.appleProductId } },
      type: 'subs',
    });
  });

  it('stores the sheet completion callback when requesting an App Store purchase', async () => {
    const onCompleted = noop;
    const setPendingPurchaseCompletedCallback = vi.fn();
    const actions = createActions({
      requestPurchase: vi.fn().mockResolvedValue(null),
      setPendingPurchaseCompletedCallback: value => {
        setPendingPurchaseCompletedCallback(value);
      },
    });

    await actions.purchase(product, { onCompleted });

    expect(setPendingPurchaseCompletedCallback).toHaveBeenCalledWith(onCompleted);
  });

  it('clears the pending sheet completion callback when purchase request fails', async () => {
    const onCompleted = noop;
    const setPendingPurchaseCompletedCallback = vi.fn();
    const actions = createActions({
      requestPurchase: vi.fn().mockRejectedValue(new Error('Could not connect to App Store')),
      setPendingPurchaseCompletedCallback: value => {
        setPendingPurchaseCompletedCallback(value);
      },
      showError: () => undefined,
    });

    await actions.purchase(product, { onCompleted });

    expect(setPendingPurchaseCompletedCallback).toHaveBeenNthCalledWith(1, onCompleted);
    expect(setPendingPurchaseCompletedCallback).toHaveBeenNthCalledWith(2, null);
  });

  it('shows an error when the App Store purchase request fails before opening the sheet', async () => {
    const showError = vi.fn();
    const actions = createActions({
      requestPurchase: vi.fn().mockRejectedValue(new Error('Could not connect to App Store')),
      showError: message => {
        showError(message);
      },
    });

    await actions.purchase(product);

    expect(showError).toHaveBeenCalledWith('Could not connect to App Store');
  });

  it('does not show an error when the user cancels the App Store purchase sheet', async () => {
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

    await actions.purchase(product);

    expect(showError).not.toHaveBeenCalled();
  });

  it('shows a single account-link message when the App Store account already owns the subscription', async () => {
    const showError = vi.fn();
    const actions = createActions({
      requestPurchase: vi.fn().mockRejectedValue({
        code: 'already-owned',
        message: 'Item already owned',
      }),
      showError: message => {
        showError(message);
      },
    });

    await actions.purchase(product);

    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith(
      'This App Store subscription is linked to another Kilo account.'
    );
  });

  it('does not finish the transaction when backend completion fails', async () => {
    const finishTransaction = vi.fn();
    const actions = createActions({
      completeAppStorePurchase: vi.fn().mockRejectedValue(new Error('backend failed')),
      finishTransaction,
    });

    await actions.handlePurchaseSuccess(createPurchase());

    expect(finishTransaction).not.toHaveBeenCalled();
  });

  it('finishes the transaction and invalidates Kilo Pass state after backend success', async () => {
    const finishTransaction = vi.fn();
    const invalidateAfterCompletion = vi.fn();
    const onPurchaseCompleted = vi.fn();
    const purchase = createPurchase();
    const actions = createActions({
      completeAppStorePurchase: vi.fn().mockResolvedValue({ alreadyProcessed: false }),
      finishTransaction,
      invalidateAfterCompletion,
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    await actions.handlePurchaseSuccess(purchase);

    expect(invalidateAfterCompletion).toHaveBeenCalled();
    expect(finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: false });
    expect(onPurchaseCompleted).toHaveBeenCalled();
  });

  it('calls the pending sheet callback after provider-owned backend completion succeeds', async () => {
    let pendingCompletion: (() => void) | null = null;
    const onPurchaseCompleted = vi.fn();
    const purchase = createPurchase();
    const actions = createActions({
      completeAppStorePurchase: vi.fn().mockResolvedValue({ alreadyProcessed: false }),
      finishTransaction: vi.fn(),
      invalidateAfterCompletion: vi.fn(),
      onPurchaseCompleted: () => {
        const pending = pendingCompletion;
        pendingCompletion = null;
        pending?.();
      },
      requestPurchase: vi.fn().mockResolvedValue(null),
      setPendingPurchaseCompletedCallback: pending => {
        pendingCompletion = pending;
      },
    });

    await actions.purchase(product, {
      onCompleted: () => {
        onPurchaseCompleted();
      },
    });
    await actions.handlePurchaseSuccess(purchase);

    expect(onPurchaseCompleted).toHaveBeenCalledTimes(1);
    expect(pendingCompletion).toBeNull();
  });

  it('does not run purchase completion callback when backend completion fails', async () => {
    const onPurchaseCompleted = vi.fn();
    const actions = createActions({
      completeAppStorePurchase: vi.fn().mockRejectedValue(new Error('backend failed')),
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    await actions.handlePurchaseSuccess(createPurchase());

    expect(onPurchaseCompleted).not.toHaveBeenCalled();
  });

  it('clears the pending sheet callback when backend completion fails', async () => {
    const setPendingPurchaseCompletedCallback = vi.fn();
    const actions = createActions({
      completeAppStorePurchase: vi.fn().mockRejectedValue(new Error('backend failed')),
      setPendingPurchaseCompletedCallback: value => {
        setPendingPurchaseCompletedCallback(value);
      },
    });

    await actions.handlePurchaseSuccess(createPurchase());

    expect(setPendingPurchaseCompletedCallback).toHaveBeenCalledWith(null);
  });

  it('does not show backend completion errors while recovering purchases in the background', async () => {
    const showError = vi.fn();
    const actions = createActions({
      completeAppStorePurchase: vi
        .fn()
        .mockRejectedValue(
          new Error('App Store purchase account token does not match the signed-in user.')
        ),
      showError: message => {
        showError(message);
      },
    });

    await actions.recoverPurchases([createPurchase()]);

    expect(showError).not.toHaveBeenCalled();
  });

  it('recovers unfinished Kilo Pass App Store purchases', async () => {
    const finishTransaction = vi.fn();
    const invalidateAfterCompletion = vi.fn();
    const completeAppStorePurchase = vi.fn().mockResolvedValue({ alreadyProcessed: false });
    const onPurchaseCompleted = vi.fn();
    const purchase = createPurchase();
    const actions = createActions({
      completeAppStorePurchase,
      finishTransaction,
      invalidateAfterCompletion,
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    await actions.recoverPurchases([
      purchase,
      {
        ...purchase,
        id: 'other-purchase',
        productId: 'other.product',
        transactionId: 'other-tx',
      },
      {
        ...purchase,
        id: 'pending-purchase',
        purchaseState: 'pending',
        transactionId: 'pending-tx',
      },
    ]);

    expect(completeAppStorePurchase).toHaveBeenCalledTimes(1);
    expect(completeAppStorePurchase).toHaveBeenCalledWith({ signedTransactionJws: 'signed-jws' });
    expect(invalidateAfterCompletion).toHaveBeenCalledTimes(1);
    expect(finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: false });
    expect(onPurchaseCompleted).not.toHaveBeenCalled();
  });

  it('invalidates Kilo Pass state once after recovering multiple purchases', async () => {
    const finishTransaction = vi.fn();
    const invalidateAfterCompletion = vi.fn();
    const completeAppStorePurchase = vi.fn().mockResolvedValue({ alreadyProcessed: false });
    const purchases = [
      createPurchase({ id: 'purchase-1', purchaseToken: 'signed-jws-1', transactionId: 'tx-1' }),
      createPurchase({ id: 'purchase-2', purchaseToken: 'signed-jws-2', transactionId: 'tx-2' }),
      createPurchase({ id: 'purchase-3', purchaseToken: 'signed-jws-3', transactionId: 'tx-3' }),
    ];
    const actions = createActions({
      completeAppStorePurchase,
      finishTransaction,
      invalidateAfterCompletion,
    });

    await actions.recoverPurchases(purchases);

    expect(completeAppStorePurchase).toHaveBeenCalledTimes(3);
    expect(finishTransaction).toHaveBeenCalledTimes(3);
    expect(invalidateAfterCompletion).toHaveBeenCalledTimes(1);
  });

  it('coalesces recovery and live callbacks for the same App Store transaction', async () => {
    const backendCompletion = createDeferredPromise();
    const completeAppStorePurchase = vi.fn().mockReturnValue(backendCompletion.promise);
    const finishTransaction = vi.fn();
    const onPurchaseCompleted = vi.fn();
    const purchase = createPurchase();
    const actions = createActions({
      completeAppStorePurchase,
      finishTransaction,
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    const recovery = actions.handlePurchaseSuccess(purchase, { notifyCompletion: false });
    const liveCallback = actions.handlePurchaseSuccess(purchase);
    backendCompletion.resolve({ alreadyProcessed: false });
    await Promise.all([recovery, liveCallback]);

    expect(completeAppStorePurchase).toHaveBeenCalledTimes(1);
    expect(finishTransaction).toHaveBeenCalledTimes(1);
    expect(onPurchaseCompleted).toHaveBeenCalledTimes(1);
  });

  it('coalesces completion across separate Kilo Pass purchase hook instances', async () => {
    const backendCompletion = createDeferredPromise();
    const completeFromRecovery = vi.fn().mockReturnValue(backendCompletion.promise);
    const completeFromSheet = vi.fn().mockResolvedValue({ alreadyProcessed: true });
    const finishFromRecovery = vi.fn();
    const finishFromSheet = vi.fn();
    const onPurchaseCompleted = vi.fn();
    const purchase = createPurchase();
    const recoveryActions = createAppStoreKiloPassPurchaseActions({
      completeAppStorePurchase: completeFromRecovery,
      enabledAppleProductIds: [product.appleProductId],
      finishTransaction: finishFromRecovery,
      invalidateAfterCompletion: vi.fn(),
      requestPurchase: vi.fn(),
      showError: () => undefined,
    });
    const sheetActions = createAppStoreKiloPassPurchaseActions({
      completeAppStorePurchase: completeFromSheet,
      enabledAppleProductIds: [product.appleProductId],
      finishTransaction: finishFromSheet,
      invalidateAfterCompletion: vi.fn(),
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
      requestPurchase: vi.fn(),
      showError: () => undefined,
    });

    const recovery = recoveryActions.handlePurchaseSuccess(purchase, { notifyCompletion: false });
    const liveCallback = sheetActions.handlePurchaseSuccess(purchase);
    backendCompletion.resolve({ alreadyProcessed: false });
    await Promise.all([recovery, liveCallback]);

    expect(completeFromRecovery).toHaveBeenCalledTimes(1);
    expect(completeFromSheet).not.toHaveBeenCalled();
    expect(finishFromRecovery).toHaveBeenCalledTimes(1);
    expect(finishFromSheet).not.toHaveBeenCalled();
    expect(onPurchaseCompleted).toHaveBeenCalledTimes(1);
  });
});
