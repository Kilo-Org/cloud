import { type Href, useRouter } from 'expo-router';
import {
  Bell,
  Globe,
  History,
  Mic,
  SlidersHorizontal,
  Wallet,
  WandSparkles,
} from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ConfigureRow } from '@/components/ui/configure-row';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import {
  setThemePreference,
  type ThemePreference,
  useThemePreference,
} from '@/lib/hooks/use-theme-preference';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';

/**
 * Preferences hub: each group s1 split into a subpage is one navigation row
 * here. The rows are moved, not redesigned — the subpages hold every switch
 * and picker verbatim; this screen only routes to them.
 */
export function PreferencesScreen() {
  const router = useRouter();
  const { preference: themePreference } = useThemePreference();
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.preferences')} backFallback={PROFILE_TAB_HREF} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        <Section>
          <RowGroup leadingTile>
            <ConfigureRow
              icon={SlidersHorizontal}
              title={t('preferences.general')}
              onPress={() => {
                router.push('/(app)/(tabs)/(3_profile)/general' as Href);
              }}
            />
            <ConfigureRow
              icon={Mic}
              title={t('preferences.voiceInput')}
              onPress={() => {
                router.push('/(app)/(tabs)/(3_profile)/voice-input' as Href);
              }}
            />
            <ConfigureRow
              icon={WandSparkles}
              title={t('preferences.toolSummaryTranslation')}
              subtitle={t('preferences.toolSummaryTranslationSubtitle')}
              onPress={() => {
                router.push('/(app)/(tabs)/(3_profile)/tool-summary-translation' as Href);
              }}
            />
          </RowGroup>
          {/* The explanation is the caption the card answers to, so the Voice
              input row keeps its two-line subtitle budget whatever the width. */}
          <Text variant="caption">{t('preferences.gatewayTranscriptionSubtitle')}</Text>
        </Section>

        <Section label={t('preferences.appearance')}>
          <SegmentedControl<ThemePreference>
            accessibilityLabel={t('preferences.appearance')}
            options={[
              { value: 'system', label: t('preferences.appearanceSystem') },
              { value: 'light', label: t('preferences.appearanceLight') },
              { value: 'dark', label: t('preferences.appearanceDark') },
            ]}
            value={themePreference}
            onChange={setThemePreference}
          />
        </Section>

        <RowGroup leadingTile>
          <ConfigureRow
            icon={Globe}
            title={t('preferences.account')}
            subtitle={t('preferences.accountSubtitle')}
            onPress={() => {
              router.push('/(app)/(tabs)/(3_profile)/account' as Href);
            }}
          />
          <ConfigureRow
            icon={Bell}
            title={t('common.notifications')}
            subtitle={t('preferences.notificationsSubtitle')}
            onPress={() => {
              router.push('/(app)/notifications' as Href);
            }}
          />
          <ConfigureRow
            icon={History}
            title={t('notifications.history.title')}
            subtitle={t('notifications.history.subtitle')}
            onPress={() => {
              router.push('/(app)/(tabs)/(3_profile)/notification-history' as Href);
            }}
          />
          <ConfigureRow
            icon={Wallet}
            title={t('notifications.channel.spend')}
            onPress={() => {
              router.push('/(app)/(tabs)/(3_profile)/spend-alerts' as Href);
            }}
          />
        </RowGroup>
      </TabScreenScrollView>
    </View>
  );
}
