import { deepLinkToSubscriptions } from 'expo-iap';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';

/**
 * Android-only Google Play subscription management helper. Loaded lazily from
 * an Android branch so iOS never reaches for the Play deeplink.
 */
export async function openPlaySubscriptionManagement(params: {
  skuAndroid: string;
  invalidateAfter: () => Promise<void> | void;
}): Promise<void> {
  try {
    await deepLinkToSubscriptions({
      skuAndroid: params.skuAndroid,
      packageNameAndroid: 'com.kilocode.kiloapp',
    });
    await params.invalidateAfter();
    setTimeout(() => {
      void params.invalidateAfter();
    }, 2000);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : i18n.t('kiloPass.manageFailedPlay'));
  }
}
