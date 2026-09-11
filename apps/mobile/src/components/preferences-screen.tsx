import { type Href, useRouter } from 'expo-router';
import { Bell, Globe, Mic, SlidersHorizontal } from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { FeatureFlagsSection } from '@/components/feature-flags-section';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ConfigureRow } from '@/components/ui/configure-row';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import {
  setThemePreference,
  type ThemePreference,
  useThemePreference,
} from '@/lib/hooks/use-theme-preference';

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
      <ScreenHeader title={t('common.preferences')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-6 gap-3 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <ConfigureRow
          icon={SlidersHorizontal}
          title={t('preferences.general')}
          className="rounded-lg bg-secondary px-3"
          last
          onPress={() => {
            router.push('/(app)/(tabs)/(3_profile)/general' as Href);
          }}
        />
        <ConfigureRow
          icon={Mic}
          title={t('preferences.voiceInput')}
          subtitle={t('preferences.gatewayTranscriptionSubtitle')}
          className="rounded-lg bg-secondary px-3"
          last
          onPress={() => {
            router.push('/(app)/(tabs)/(3_profile)/voice-input' as Href);
          }}
        />

        {/* Appearance */}
        <View className="mt-3 gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('preferences.appearance')}
          </Text>
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
        </View>

        {__DEV__ ? <FeatureFlagsSection /> : null}

        <ConfigureRow
          icon={Globe}
          title={t('preferences.account')}
          subtitle={t('preferences.accountSubtitle')}
          className="rounded-lg bg-secondary px-3"
          last
          onPress={() => {
            router.push('/(app)/(tabs)/(3_profile)/account' as Href);
          }}
        />
        <ConfigureRow
          icon={Bell}
          title={t('common.notifications')}
          subtitle={t('preferences.notificationsSubtitle')}
          className="rounded-lg bg-secondary px-3"
          last
          onPress={() => {
            router.push('/(app)/(tabs)/(3_profile)/notifications' as Href);
          }}
        />
      </TabScreenScrollView>
    </View>
  );
}
