import { type Purchase } from 'expo-iap';

type AppStoreKiloPassOwnership = 'checking' | 'current-account' | 'another-account' | 'none';

type AppStorePurchase = Purchase & { appAccountToken?: string | null };

function isKiloPassAppStorePurchase(
  purchase: Purchase,
  enabledAppleProductIds: readonly string[]
): purchase is AppStorePurchase {
  if (purchase.purchaseState === 'pending') {
    return false;
  }
  if (purchase.store !== 'apple') {
    return false;
  }
  return enabledAppleProductIds.includes(purchase.productId);
}

export function getAppStoreKiloPassOwnership(params: {
  appAccountToken: string | null | undefined;
  enabledAppleProductIds: readonly string[];
  purchases: readonly Purchase[];
}): AppStoreKiloPassOwnership {
  if (!params.appAccountToken) {
    return 'checking';
  }

  const kiloPassPurchases = params.purchases.filter(purchase =>
    isKiloPassAppStorePurchase(purchase, params.enabledAppleProductIds)
  );
  if (kiloPassPurchases.length === 0) {
    return 'none';
  }

  if (kiloPassPurchases.some(purchase => purchase.appAccountToken === params.appAccountToken)) {
    return 'current-account';
  }

  return 'another-account';
}
