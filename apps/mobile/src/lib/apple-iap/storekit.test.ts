import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finishTransaction,
  initConnection,
  type Purchase,
  type PurchaseError,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
} from 'expo-iap';

import {
  finishStoreKitTransaction,
  purchaseStoreKitProduct,
  STOREKIT_PURCHASE_TIMEOUT_MS,
} from './storekit';

const listenerState = vi.hoisted(() => ({
  onPurchase: null as ((purchase: Purchase) => void) | null,
  onPurchaseError: null as ((error: PurchaseError) => void) | null,
  purchaseErrorRemove: vi.fn(),
  purchaseRemove: vi.fn(),
}));

function makePurchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: 'transaction-id',
    isAutoRenewing: false,
    platform: 'ios',
    productId: 'com.kilocode.kiloapp.credits.small.999',
    purchaseState: 'purchased',
    purchaseToken: 'signed-transaction-jws',
    quantity: 1,
    store: 'apple',
    transactionDate: Date.now(),
    ...overrides,
  };
}

vi.mock('expo-iap', () => ({
  finishTransaction: vi.fn(),
  initConnection: vi.fn(),
  purchaseErrorListener: vi.fn((listener: (error: PurchaseError) => void) => {
    listenerState.onPurchaseError = listener;
    return { remove: listenerState.purchaseErrorRemove };
  }),
  purchaseUpdatedListener: vi.fn((listener: (purchase: Purchase) => void) => {
    listenerState.onPurchase = listener;
    return { remove: listenerState.purchaseRemove };
  }),
  requestPurchase: vi.fn(),
}));

beforeEach(() => {
  vi.useRealTimers();
  listenerState.onPurchase = null;
  listenerState.onPurchaseError = null;
  listenerState.purchaseErrorRemove.mockClear();
  listenerState.purchaseRemove.mockClear();
  vi.clearAllMocks();
  vi.mocked(initConnection).mockResolvedValue(true);
  vi.mocked(requestPurchase).mockResolvedValue(
    makePurchase({
      productId: 'ignored-return-value',
      purchaseToken: 'ignored-token',
    })
  );
  vi.mocked(finishTransaction).mockResolvedValue(undefined);
});

describe('purchaseStoreKitProduct', () => {
  it('resolves from purchaseUpdatedListener instead of requestPurchase return value', async () => {
    const purchasePromise = purchaseStoreKitProduct('com.kilocode.kiloapp.credits.small.999');
    await Promise.resolve();

    expect(vi.mocked(purchaseUpdatedListener).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(requestPurchase).mock.invocationCallOrder[0] ?? 0
    );
    expect(vi.mocked(purchaseErrorListener).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(requestPurchase).mock.invocationCallOrder[0] ?? 0
    );
    expect(requestPurchase).toHaveBeenCalledWith({
      request: { apple: { sku: 'com.kilocode.kiloapp.credits.small.999' } },
      type: 'in-app',
    });

    listenerState.onPurchase?.(
      makePurchase({
        productId: 'com.kilocode.kiloapp.credits.small.999',
        purchaseToken: 'listener-signed-transaction',
      })
    );

    await expect(purchasePromise).resolves.toMatchObject({
      productId: 'com.kilocode.kiloapp.credits.small.999',
      transactionJws: 'listener-signed-transaction',
    });
    expect(listenerState.purchaseRemove).toHaveBeenCalledTimes(1);
    expect(listenerState.purchaseErrorRemove).toHaveBeenCalledTimes(1);
  });

  it('ignores purchaseUpdatedListener events for other products', async () => {
    const purchasePromise = purchaseStoreKitProduct('com.kilocode.kiloapp.credits.small.999');
    await Promise.resolve();

    listenerState.onPurchase?.(
      makePurchase({
        productId: 'com.kilocode.kiloapp.credits.large.4999',
        purchaseToken: 'wrong-product-token',
      })
    );
    listenerState.onPurchase?.(
      makePurchase({
        productId: 'com.kilocode.kiloapp.credits.small.999',
        purchaseToken: 'right-product-token',
      })
    );

    await expect(purchasePromise).resolves.toMatchObject({
      transactionJws: 'right-product-token',
    });
  });

  it('rejects when the matching purchase is missing a signed transaction JWS', async () => {
    const purchasePromise = purchaseStoreKitProduct('com.kilocode.kiloapp.credits.small.999');
    await Promise.resolve();

    listenerState.onPurchase?.(
      makePurchase({
        productId: 'com.kilocode.kiloapp.credits.small.999',
        purchaseToken: null,
      })
    );

    await expect(purchasePromise).rejects.toThrow(
      'StoreKit purchase did not include a signed transaction JWS'
    );
  });

  it('rejects when purchaseErrorListener receives an error', async () => {
    const purchasePromise = purchaseStoreKitProduct('com.kilocode.kiloapp.credits.small.999');
    await Promise.resolve();

    listenerState.onPurchaseError?.({
      code: 'user-cancelled' as PurchaseError['code'],
      message: 'User cancelled purchase',
      productId: 'com.kilocode.kiloapp.credits.small.999',
    });

    await expect(purchasePromise).rejects.toThrow('User cancelled purchase');
    expect(listenerState.purchaseRemove).toHaveBeenCalledTimes(1);
    expect(listenerState.purchaseErrorRemove).toHaveBeenCalledTimes(1);
  });

  it('rejects if StoreKit never emits a purchase event', async () => {
    vi.useFakeTimers();
    const purchasePromise = purchaseStoreKitProduct('com.kilocode.kiloapp.credits.small.999');
    await Promise.resolve();
    const rejection = expect(purchasePromise).rejects.toThrow('StoreKit purchase timed out');

    await vi.advanceTimersByTimeAsync(STOREKIT_PURCHASE_TIMEOUT_MS);

    await rejection;
    expect(listenerState.purchaseRemove).toHaveBeenCalledTimes(1);
    expect(listenerState.purchaseErrorRemove).toHaveBeenCalledTimes(1);
  });
});

describe('finishStoreKitTransaction', () => {
  it('finishes credit pack transactions as consumable', async () => {
    const purchase = makePurchase();

    await finishStoreKitTransaction(purchase);

    expect(finishTransaction).toHaveBeenCalledWith({
      purchase,
      isConsumable: true,
    });
  });
});
