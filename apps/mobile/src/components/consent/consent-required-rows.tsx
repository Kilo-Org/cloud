import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ConsentRow } from '@/components/consent/consent-row';
import { MessageSquare, Smartphone, Sparkles, User } from '@/components/ui/icons';

/**
 * The disclosures the app cannot work without, in the order the consent card
 * lists them: what is sent, to whom, and that the account email reaches PostHog
 * so it can decide which features this person sees.
 */
export function ConsentRequiredRows() {
  const { t } = useTranslation();

  return (
    <View className="mt-3 gap-5">
      <ConsentRow
        icon={MessageSquare}
        title={t('consent.promptsTitle')}
        description={t('consent.promptsDescription')}
      />
      <ConsentRow
        icon={User}
        title={t('consent.accountTitle')}
        description={t('consent.accountDescription')}
      />
      <ConsentRow
        icon={Smartphone}
        title={t('consent.diagnosticsTitle')}
        description={t('consent.diagnosticsDescription')}
      />
      <ConsentRow
        icon={Sparkles}
        title={t('consent.featureFlagsTitle')}
        description={t('consent.featureFlagsDescription')}
      />
    </View>
  );
}
