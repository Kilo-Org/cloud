import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ExternalBillingLink } from '@/components/organization/external-billing-link';

type BillingWebSettingsProps = Readonly<{
  /** The organization's subscription page; the seats page hangs off it. */
  subscriptionsUrl: string;
  /** The plan row's words, or null when the ended-plan banner already carries it. */
  planLabel: string | null;
  /** The page that configures auto top-up. */
  autoTopUpUrl: string;
  /** The auto top-up row's words, which follow the read's state. */
  autoTopUpLabel: string;
}>;

/**
 * The billing settings that only the web can change — the plan, the seats and
 * auto top-up.
 *
 * Each destination is drawn by `ExternalBillingLink`: a link on an iOS build in
 * the US storefront, a statement of where the setting lives everywhere else.
 * The statement is the whole of that shape, so a storefront that may not link
 * to web billing is handed no action to take.
 */
export function BillingWebSettings({
  subscriptionsUrl,
  planLabel,
  autoTopUpUrl,
  autoTopUpLabel,
}: BillingWebSettingsProps) {
  const { t } = useTranslation();
  return (
    <View className="gap-3 rounded-lg bg-secondary p-3">
      {planLabel === null ? null : (
        <ExternalBillingLink
          url={subscriptionsUrl}
          label={planLabel}
          description={t('organization.billing.planManagedOnWeb')}
        />
      )}
      <ExternalBillingLink
        url={`${subscriptionsUrl}/seats`}
        label={t('organization.billing.buySeats')}
        description={t('organization.billing.seatsManagedOnWeb')}
      />
      <ExternalBillingLink
        url={autoTopUpUrl}
        label={autoTopUpLabel}
        description={t('organization.billing.autoTopUpManagedOnWeb')}
      />
    </View>
  );
}
