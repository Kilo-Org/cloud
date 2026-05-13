import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';

export const APP_STORE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';

export type KiloPassExternalManagementAction = {
  label: 'Manage in App Store';
  providerLabel: 'App Store';
  url: typeof APP_STORE_SUBSCRIPTIONS_URL;
};

export type KiloPassProviderManagementModel = {
  paymentMethodLabel: 'Stripe' | 'App Store' | 'Google Play';
  canUseWebControls: boolean;
  canUseStripePortal: boolean;
  canChangePlan: boolean;
  canUseChurnkeyCancel: boolean;
  canResumeInWeb: boolean;
  canUseScheduledChanges: boolean;
  canViewBillingHistory: boolean;
  externalManagementAction: KiloPassExternalManagementAction | null;
  providerManagedCopy: string | null;
};

function assertNever(value: never): never {
  throw new Error(`Unhandled Kilo Pass payment provider: ${value}`);
}

export function getKiloPassProviderManagementModel(
  paymentProvider: KiloPassPaymentProvider
): KiloPassProviderManagementModel {
  switch (paymentProvider) {
    case KiloPassPaymentProvider.Stripe:
      return {
        paymentMethodLabel: 'Stripe',
        canUseWebControls: true,
        canUseStripePortal: true,
        canChangePlan: true,
        canUseChurnkeyCancel: true,
        canResumeInWeb: true,
        canUseScheduledChanges: true,
        canViewBillingHistory: true,
        externalManagementAction: null,
        providerManagedCopy: null,
      };
    case KiloPassPaymentProvider.AppStore:
      return {
        paymentMethodLabel: 'App Store',
        canUseWebControls: false,
        canUseStripePortal: false,
        canChangePlan: false,
        canUseChurnkeyCancel: false,
        canResumeInWeb: false,
        canUseScheduledChanges: false,
        canViewBillingHistory: false,
        externalManagementAction: {
          label: 'Manage in App Store',
          providerLabel: 'App Store',
          url: APP_STORE_SUBSCRIPTIONS_URL,
        },
        providerManagedCopy: 'Managed in the App Store.',
      };
    case KiloPassPaymentProvider.GooglePlay:
      return {
        paymentMethodLabel: 'Google Play',
        canUseWebControls: false,
        canUseStripePortal: false,
        canChangePlan: false,
        canUseChurnkeyCancel: false,
        canResumeInWeb: false,
        canUseScheduledChanges: false,
        canViewBillingHistory: false,
        externalManagementAction: null,
        providerManagedCopy: 'Managed in Google Play.',
      };
    default:
      return assertNever(paymentProvider);
  }
}
