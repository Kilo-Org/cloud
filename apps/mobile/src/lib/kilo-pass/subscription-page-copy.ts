import { i18n } from '@/i18n';

export const KILO_PASS_SUBSCRIPTION_HEADER_DESCRIPTION = i18n.t(
  'kiloPass.subscriptionHeaderDescription'
);

export function formatKiloPassTierDescription(webMonthlyPriceUsd: number): string {
  return i18n.t('kiloPass.tierDescription', { price: webMonthlyPriceUsd });
}
