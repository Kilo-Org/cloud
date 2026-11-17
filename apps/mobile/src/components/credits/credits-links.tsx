import { type Href, useRouter } from 'expo-router';
import { FileText, Receipt } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ConfigureRow } from '@/components/ui/configure-row';

/**
 * The rows under the personal Credits section: the person's own credit history
 * and invoices.
 *
 * The person's credit packs are bought in the app through the store, so this
 * section has no web billing destination: a link out would offer the same
 * purchase somewhere the store cannot vet it, which both stores refuse.
 */
export function PersonalCreditsLinks() {
  const { t } = useTranslation();
  const router = useRouter();

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
        last
        onPress={() => {
          router.push('/(app)/(tabs)/(3_profile)/invoices' as Href);
        }}
      />
    </View>
  );
}
