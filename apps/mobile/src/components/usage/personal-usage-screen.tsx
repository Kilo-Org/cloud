import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { ScreenHeader } from '@/components/screen-header';
import { UsageContent } from '@/components/usage/usage-content';
import { type UsageScope } from '@/lib/hooks/use-usage-analytics';

/** Module scope so the hook's filter memo stays stable across renders. */
const PERSONAL_SCOPE: UsageScope = { kind: 'personal' };

/**
 * The account's own usage: the same numbers web's `/usage` page opens on, read
 * for personal usage only (rows with no organization behind them).
 */
export function PersonalUsageScreen() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('usage.title')} />
      <DetailScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pb-6 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <UsageContent scope={PERSONAL_SCOPE} />
      </DetailScreenScrollView>
    </View>
  );
}
