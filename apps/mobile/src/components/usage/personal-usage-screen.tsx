import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { ScreenHeader } from '@/components/screen-header';
import { UsageContent } from '@/components/usage/usage-content';
import { type UsageScope } from '@/lib/hooks/use-usage-analytics';
import { SCREEN_BODY_CLASS } from '@/lib/layout';

/** Module scope so the hook's filter memo stays stable across renders. */
const PERSONAL_SCOPE: UsageScope = { kind: 'personal' };

/**
 * The account's own usage: the same numbers web's `/usage` page opens on, read
 * for personal usage only (rows with no organization behind them).
 *
 * The header names the scope, the way the organization screen's does. Profile
 * opens this screen beside a Credits card that follows the selected
 * organization, so a bare "Usage" title let the reader take these totals for
 * the organization's.
 */
export function PersonalUsageScreen() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('usage.personalTitle')} />
      <DetailScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        <UsageContent scope={PERSONAL_SCOPE} />
      </DetailScreenScrollView>
    </View>
  );
}
