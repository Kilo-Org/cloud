import {
  fetchProducts,
  finishTransaction,
  initConnection,
  type Purchase,
  requestPurchase,
} from 'expo-iap';

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

export async function purchaseStoreKitProduct(productId: string): Promise<StoreKitPurchaseResult> {
  await initConnection();
  const purchaseResult = await requestPurchase({
    request: { apple: { sku: productId } },
    type: 'in-app',
  });
  const purchase = Array.isArray(purchaseResult) ? purchaseResult[0] : purchaseResult;
  if (!purchase) {
    throw new Error('StoreKit purchase did not return a transaction');
  }
  const transactionJws = purchase.purchaseToken;
  if (!transactionJws) {
    throw new Error('StoreKit purchase did not include a signed transaction JWS');
  }

  return { productId, transactionJws, nativeTransaction: purchase };
}

export async function finishStoreKitTransaction(nativeTransaction: Purchase): Promise<void> {
  await finishTransaction({ purchase: nativeTransaction, isConsumable: true });
}
