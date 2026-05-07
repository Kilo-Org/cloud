import { type Purchase } from 'expo-iap';
import { describe, expect, it, vi } from 'vitest';
import { createAppStoreKiloPassPurchaseActions } from './use-store-kilo-pass-purchase';
import { type AppStoreKiloPassProduct } from './store-products';

vi.mock('expo-iap', () => ({
  ErrorCode: {
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

const product: AppStoreKiloPassProduct = {
  appleProductId: 'kilopass.tier19.monthly.v1',
  cadence: 'monthly',
  description: 'Kilo Pass',
  displayPrice: '$24.99',
  googleBasePlanId: 'monthly-v1',
  googleProductId: 'kilopass_tier19',
  storeProduct: {
    id: 'kilopass.tier19.monthly.v1',
    displayPrice: '$24.99',
    title: 'Kilo Pass',
    description: 'Kilo Pass',
  },
  suggestedStoreMonthlyPriceUsd: 24.7,
  tier: 'tier_19',
  title: 'Kilo Pass',
  webMonthlyPriceUsd: 19,
};

describe('createAppStoreKiloPassPurchaseActions', () => {
  it('requests an App Store subscription purchase', async () => {
    const requestPurchase = vi.fn().mockResolvedValue(null);
    const actions = createAppStoreKiloPassPurchaseActions({
      completeAppStorePurchase: vi.fn(),
      finishTransaction: vi.fn(),
      invalidateAfterCompletion: vi.fn(),
      requestPurchase,
      showError: () => undefined,
    });

    await actions.purchase(product);

    expect(requestPurchase).toHaveBeenCalledWith({
      request: { apple: { sku: product.appleProductId } },
      type: 'subs',
    });
  });

  it('shows an error when the App Store purchase request fails before opening the sheet', async () => {
    const showError = vi.fn();
    const actions = createAppStoreKiloPassPurchaseActions({
      completeAppStorePurchase: vi.fn(),
      finishTransaction: vi.fn(),
      invalidateAfterCompletion: vi.fn(),
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
    const actions = createAppStoreKiloPassPurchaseActions({
      completeAppStorePurchase: vi.fn(),
      finishTransaction: vi.fn(),
      invalidateAfterCompletion: vi.fn(),
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

  it('does not finish the transaction when backend completion fails', async () => {
    const finishTransaction = vi.fn();
    const actions = createAppStoreKiloPassPurchaseActions({
      completeAppStorePurchase: vi.fn().mockRejectedValue(new Error('backend failed')),
      finishTransaction,
      invalidateAfterCompletion: vi.fn(),
      requestPurchase: vi.fn(),
      showError: () => undefined,
    });

    await actions.handlePurchaseSuccess({
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
    });

    expect(finishTransaction).not.toHaveBeenCalled();
  });

  it('finishes the transaction and invalidates Kilo Pass state after backend success', async () => {
    const finishTransaction = vi.fn();
    const invalidateAfterCompletion = vi.fn();
    const purchase = {
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
    } satisfies Purchase;
    const actions = createAppStoreKiloPassPurchaseActions({
      completeAppStorePurchase: vi.fn().mockResolvedValue({ alreadyProcessed: false }),
      finishTransaction,
      invalidateAfterCompletion,
      requestPurchase: vi.fn(),
      showError: () => undefined,
    });

    await actions.handlePurchaseSuccess(purchase);

    expect(invalidateAfterCompletion).toHaveBeenCalled();
    expect(finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: false });
  });

  it('recovers unfinished Kilo Pass App Store purchases', async () => {
    const finishTransaction = vi.fn();
    const completeAppStorePurchase = vi.fn().mockResolvedValue({ alreadyProcessed: false });
    const purchase = {
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
    } satisfies Purchase;
    const actions = createAppStoreKiloPassPurchaseActions({
      completeAppStorePurchase,
      finishTransaction,
      invalidateAfterCompletion: vi.fn(),
      requestPurchase: vi.fn(),
      showError: () => undefined,
    });

    await actions.recoverPurchases([
      purchase,
      {
        ...purchase,
        id: 'other-purchase',
        productId: 'not-kilopass',
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
    expect(finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: false });
  });
});
