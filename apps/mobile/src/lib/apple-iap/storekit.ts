import {
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  type Purchase,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
} from 'expo-iap';

export const STOREKIT_PURCHASE_TIMEOUT_MS = 2 * 60_000;

export type StoreKitProduct = {
  id: string;
  title: string;
  localizedPrice: string;
};

export type StoreKitPurchaseResult = {
  productId: string;
  transactionJws: string;
  nativeTransaction: Purchase;
};

export async function fetchStoreKitProducts(productIds: string[]): Promise<StoreKitProduct[]> {
  await initConnection();
  const products = await fetchProducts({ skus: productIds, type: 'in-app' });
  return (products ?? []).map(product => ({
    id: product.id,
    title: product.title,
    localizedPrice: product.displayPrice,
  }));
}

function purchaseErrorToError(error: { message?: string | null }): Error {
  return new Error(error.message ?? 'StoreKit purchase failed');
}

function toStoreKitPurchaseResult(productId: string, purchase: Purchase): StoreKitPurchaseResult {
  if (purchase.productId !== productId) {
    throw new Error(`StoreKit returned transaction for unexpected product ${purchase.productId}`);
  }
  const transactionJws = purchase.purchaseToken;
  if (!transactionJws) {
    throw new Error('StoreKit purchase did not include a signed transaction JWS');
  }
  return { productId, transactionJws, nativeTransaction: purchase };
}

export async function purchaseStoreKitProduct(productId: string): Promise<StoreKitPurchaseResult> {
  await initConnection();

  return new Promise<StoreKitPurchaseResult>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let purchaseSubscription: { remove: () => void } | null = null;
    let errorSubscription: { remove: () => void } | null = null;

    const cleanup = () => {
      purchaseSubscription?.remove();
      errorSubscription?.remove();
      if (timeout) {
        clearTimeout(timeout);
      }
    };

    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error('StoreKit purchase failed'));
    };

    const resolveOnce = (purchase: Purchase) => {
      if (settled) {
        return;
      }
      try {
        const result = toStoreKitPurchaseResult(productId, purchase);
        settled = true;
        cleanup();
        resolve(result);
      } catch (error) {
        rejectOnce(error);
      }
    };

    timeout = setTimeout(() => {
      rejectOnce(new Error('StoreKit purchase timed out'));
    }, STOREKIT_PURCHASE_TIMEOUT_MS);

    purchaseSubscription = purchaseUpdatedListener(purchase => {
      if (purchase.productId !== productId) {
        return;
      }
      resolveOnce(purchase);
    });

    // Native purchase errors are delivered through expo-iap's event callback.
    // eslint-disable-next-line promise/prefer-await-to-callbacks
    errorSubscription = purchaseErrorListener(error => {
      if (error.productId && error.productId !== productId) {
        return;
      }
      rejectOnce(purchaseErrorToError(error));
    });

    void (async () => {
      try {
        await requestPurchase({
          request: { apple: { sku: productId } },
          type: 'in-app',
        });
      } catch (error) {
        rejectOnce(error);
      }
    })();
  });
}

export async function getUnfinishedStoreKitPurchases(
  productIds: string[]
): Promise<StoreKitPurchaseResult[]> {
  await initConnection();
  const productIdSet = new Set(productIds);
  const purchases = await getAvailablePurchases({
    alsoPublishToEventListenerIOS: false,
    onlyIncludeActiveItemsIOS: false,
  });

  return purchases.flatMap(purchase => {
    if (!productIdSet.has(purchase.productId)) {
      return [];
    }
    return [toStoreKitPurchaseResult(purchase.productId, purchase)];
  });
}

export async function finishStoreKitTransaction(nativeTransaction: Purchase): Promise<void> {
  await finishTransaction({ purchase: nativeTransaction, isConsumable: true });
}
