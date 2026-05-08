import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';

export const APP_STORE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';

export type KiloPassExternalManagementAction = {
  label: 'Manage in App Store';
  providerLabel: 'App Store';
  url: typeof APP_STORE_SUBSCRIPTIONS_URL;
};

export function getKiloPassExternalManagementAction(
  paymentProvider: KiloPassPaymentProvider
): KiloPassExternalManagementAction | null {
  if (paymentProvider === KiloPassPaymentProvider.AppStore) {
    return {
      label: 'Manage in App Store',
      providerLabel: 'App Store',
      url: APP_STORE_SUBSCRIPTIONS_URL,
    };
  }

  return null;
}
