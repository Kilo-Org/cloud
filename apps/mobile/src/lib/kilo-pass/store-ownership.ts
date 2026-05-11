import { type Purchase } from 'expo-iap';

type AppStoreKiloPassOwnership = 'checking' | 'current-account' | 'another-account' | 'none';

type AppStorePurchase = Purchase & { appAccountToken?: string | null };

function isKiloPassAppStorePurchase(purchase: Purchase): purchase is AppStorePurchase {
  if (purchase.purchaseState === 'pending') {
    return false;
  }
  if (purchase.store !== 'apple') {
    return false;
  }
  return purchase.productId.startsWith('kilopass.');
}

export function getAppStoreKiloPassOwnership(params: {
  appAccountToken: string | null | undefined;
  purchases: readonly Purchase[];
}): AppStoreKiloPassOwnership {
  if (!params.appAccountToken) {
    return 'checking';
  }

  const kiloPassPurchases = params.purchases.filter(purchase =>
    isKiloPassAppStorePurchase(purchase)
  );
  if (kiloPassPurchases.length === 0) {
    return 'none';
  }

  if (kiloPassPurchases.some(purchase => purchase.appAccountToken === params.appAccountToken)) {
    return 'current-account';
  }

  return 'another-account';
}
