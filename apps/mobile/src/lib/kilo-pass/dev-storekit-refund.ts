type DevStoreKitRefundSubscription = {
  cadence: string;
  paymentProvider: string;
  tier: string;
};

type DevStoreKitRefundProduct = {
  appleProductId: string;
  cadence: string;
  tier: string;
};

export function getDevStoreKitRefundAppleProductId(params: {
  isDev?: boolean;
  products: readonly DevStoreKitRefundProduct[];
  subscription: DevStoreKitRefundSubscription | null | undefined;
}): string | null {
  const isDev = params.isDev ?? __DEV__;
  const subscription = params.subscription;
  if (!isDev || !subscription) {
    return null;
  }
  if (subscription.paymentProvider !== 'app_store' || subscription.cadence !== 'monthly') {
    return null;
  }
  return (
    params.products.find(
      product => product.tier === subscription.tier && product.cadence === subscription.cadence
    )?.appleProductId ?? null
  );
}

export async function requestDevStoreKitRefund(params: {
  appleProductId: string;
  beginRefundRequest: (appleProductId: string) => Promise<string | null>;
  invalidateAfterRefund: () => Promise<void> | void;
  showError: (message: string) => void;
  showSuccess: (message: string) => void;
}): Promise<void> {
  try {
    const refundRequestStatus = await params.beginRefundRequest(params.appleProductId);
    if (refundRequestStatus?.toLowerCase() !== 'success') {
      return;
    }
    await params.invalidateAfterRefund();
    params.showSuccess('Refund request submitted.');
  } catch (error) {
    params.showError(error instanceof Error ? error.message : 'Failed to request refund.');
  }
}
