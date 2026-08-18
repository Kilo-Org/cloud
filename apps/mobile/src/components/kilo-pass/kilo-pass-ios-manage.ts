import { beginRefundRequestIOS, showManageSubscriptionsIOS } from 'expo-iap';
import { toast } from 'sonner-native';

import { requestDevStoreKitRefund } from '@/lib/kilo-pass/dev-storekit-refund';

/**
 * iOS-only App Store management helpers. This module is the only place the
 * profile card reaches for `expo-iap` store APIs, and it is loaded lazily from
 * an iOS branch, so Android never initializes Play Billing through it.
 */

export async function openAppStoreManagement(params: {
  invalidateAfter: () => Promise<void> | void;
}): Promise<void> {
  try {
    await showManageSubscriptionsIOS();
    await params.invalidateAfter();
    setTimeout(() => {
      void params.invalidateAfter();
    }, 2000);
  } catch (error) {
    toast.error(
      error instanceof Error ? error.message : 'Failed to open App Store subscription management.'
    );
  }
}

export function requestDevAppStoreRefund(params: {
  appleProductId: string;
  invalidateAfterRefund: () => Promise<void> | void;
}): void {
  void requestDevStoreKitRefund({
    appleProductId: params.appleProductId,
    beginRefundRequest: beginRefundRequestIOS,
    invalidateAfterRefund: params.invalidateAfterRefund,
    showError: message => {
      toast.error(message);
    },
    showSuccess: message => {
      toast.success(message);
    },
  });
}
