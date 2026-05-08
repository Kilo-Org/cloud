type DevStoreKitRefundSubscription = {
  cadence: string;
  paymentProvider: string;
  tier: string;
};

const APPLE_MONTHLY_PRODUCT_ID_BY_TIER: Record<string, string> = {
  tier_19: 'kilopass.tier19.monthly.v1',
  tier_49: 'kilopass.tier49.monthly.v1',
  tier_199: 'kilopass.tier199.monthly.v1',
};

export function getDevStoreKitRefundAppleProductId(params: {
  isDev?: boolean;
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
  return APPLE_MONTHLY_PRODUCT_ID_BY_TIER[subscription.tier] ?? null;
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
