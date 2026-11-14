import { type Href, useRouter } from 'expo-router';
import { FileText, Receipt, Wallet } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ConfigureRow } from '@/components/ui/configure-row';
import { personalBillingUrl } from '@/lib/credits/add-credits-destination';
import { canOpenExternalBilling } from '@/lib/credits/external-billing-link';
import { openExternalUrl } from '@/lib/external-link';

/**
 * The rows under the personal Credits section: the person's own credit history
 * and invoices, and the one web destination for everything the app does not
 * manage here.
 *
 * The web billing page is a link on Android only. On iOS the same row stays as
 * plain text saying where billing is managed, with no chevron and no link:
 * pointing an iOS reader at a page that sells credits would be the external
 * purchase link review refuses. `canOpenExternalBilling` owns that split.
 */
export function PersonalCreditsLinks() {
  const { t } = useTranslation();
  const router = useRouter();
  const canLinkBilling = canOpenExternalBilling();

  return (
    <View className="gap-3">
      <ConfigureRow
        icon={Receipt}
        title={t('common.creditHistory')}
        subtitle={t('profile.creditHistorySubtitle')}
        hue="moss"
        className="rounded-lg bg-secondary px-3"
        onPress={() => {
          router.push('/(app)/(tabs)/(3_profile)/credit-history' as Href);
        }}
      />
      <ConfigureRow
        icon={FileText}
        title={t('organization.invoices.title')}
        subtitle={t('profile.invoicesSubtitle')}
        hue="moss"
        className="rounded-lg bg-secondary px-3"
        onPress={() => {
          router.push('/(app)/(tabs)/(3_profile)/invoices' as Href);
        }}
      />
      <ConfigureRow
        icon={Wallet}
        title={t('profile.manageBilling')}
        subtitle={canLinkBilling ? undefined : t('profile.manageBillingIosNote')}
        hue="moss"
        className="rounded-lg bg-secondary px-3"
        last
        onPress={
          canLinkBilling
            ? () => {
                void openExternalUrl(personalBillingUrl(), {
                  label: t('profile.manageBilling'),
                });
              }
            : undefined
        }
      />
    </View>
  );
}
