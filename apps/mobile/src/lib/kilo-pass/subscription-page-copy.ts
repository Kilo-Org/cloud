import { i18n } from '@/i18n';
import { formatUsd } from '@/lib/format';

export const KILO_PASS_SUBSCRIPTION_HEADER_DESCRIPTION = i18n.t(
  'kiloPass.subscriptionHeaderDescription'
);

export function formatKiloPassTierDescription(webMonthlyPriceUsd: number): string {
  return i18n.t('kiloPass.tierDescription', {
    price: formatUsd(webMonthlyPriceUsd, i18n.language, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }),
  });
}
