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
import {
  SettingsSearchScrollView,
  SettingsTarget,
} from '@/components/settings-search/settings-target';
import { ConfigureRow } from '@/components/ui/configure-row';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  setThemePreference,
  type ThemePreference,
  useThemePreference,
} from '@/lib/hooks/use-theme-preference';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import {
  ACCOUNT_SETTING,
  APPEARANCE_DARK_SETTING,
  APPEARANCE_LIGHT_SETTING,
  APPEARANCE_SETTING,
  APPEARANCE_SYSTEM_SETTING,
  GENERAL_SETTING,
  NOTIFICATION_HISTORY_SETTING,
  NOTIFICATIONS_SETTING,
  SPEND_ALERTS_SETTING,
  TOOL_SUMMARY_TRANSLATION_SETTING,
  VOICE_INPUT_SETTING,
} from '@/lib/settings-search/preference-sources';

/**
 * Preferences hub: each group s1 split into a subpage is one navigation row
 * here. The rows are moved, not redesigned — the subpages hold every switch
 * and picker verbatim; this screen only routes to them.
 *
 * Every row is also wrapped in the search target the index names, so a search
 * result lands on the row instead of only opening this screen.
 */
export function PreferencesScreen({
  settingsTarget,
}: Readonly<{ settingsTarget?: string }>) {
  const router = useRouter();
  const { preference: themePreference } = useThemePreference();
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.preferences')} backFallback={PROFILE_TAB_HREF} />
      <SettingsSearchScrollView
        settingsTarget={settingsTarget}
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        <Section>
          <RowGroup leadingTile>
            <SettingsTarget item={GENERAL_SETTING}>
              <ConfigureRow
                icon={SlidersHorizontal}
                title={t(GENERAL_SETTING.label)}
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/general' as Href);
                }}
              />
            </SettingsTarget>
            <SettingsTarget item={VOICE_INPUT_SETTING}>
              <ConfigureRow
                icon={Mic}
                title={t(VOICE_INPUT_SETTING.label)}
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/voice-input' as Href);
                }}
              />
            </SettingsTarget>
            <SettingsTarget item={TOOL_SUMMARY_TRANSLATION_SETTING}>
              <ConfigureRow
                icon={WandSparkles}
                title={t(TOOL_SUMMARY_TRANSLATION_SETTING.label)}
                subtitle={t('preferences.toolSummaryTranslationSubtitle')}
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/tool-summary-translation' as Href);
                }}
              />
            </SettingsTarget>
          </RowGroup>
        </Section>

        <Section label={t(APPEARANCE_SETTING.label)}>
          <SettingsTarget
            item={APPEARANCE_SETTING}
            targetIds={[
              APPEARANCE_SYSTEM_SETTING.id,
              APPEARANCE_LIGHT_SETTING.id,
              APPEARANCE_DARK_SETTING.id,
            ]}
          >
            <SegmentedControl<ThemePreference>
              accessibilityLabel={t(APPEARANCE_SETTING.label)}
              options={[
                { value: 'system', label: t(APPEARANCE_SYSTEM_SETTING.label) },
                { value: 'light', label: t(APPEARANCE_LIGHT_SETTING.label) },
                { value: 'dark', label: t(APPEARANCE_DARK_SETTING.label) },
              ]}
              value={themePreference}
              onChange={setThemePreference}
            />
          </SettingsTarget>
        </Section>

        <RowGroup leadingTile>
          <SettingsTarget item={ACCOUNT_SETTING}>
            <ConfigureRow
              icon={Globe}
              title={t(ACCOUNT_SETTING.label)}
              subtitle={t('preferences.accountSubtitle')}
              onPress={() => {
                router.push('/(app)/(tabs)/(3_profile)/account' as Href);
              }}
            />
          </SettingsTarget>
          <SettingsTarget item={NOTIFICATIONS_SETTING}>
            <ConfigureRow
              icon={Bell}
              title={t(NOTIFICATIONS_SETTING.label)}
              subtitle={t('preferences.notificationsSubtitle')}
              onPress={() => {
                router.push('/(app)/notifications' as Href);
              }}
            />
          </SettingsTarget>
          <SettingsTarget item={NOTIFICATION_HISTORY_SETTING}>
            <ConfigureRow
              icon={History}
              title={t(NOTIFICATION_HISTORY_SETTING.label)}
              subtitle={t('notifications.history.subtitle')}
              onPress={() => {
                router.push('/(app)/(tabs)/(3_profile)/notification-history' as Href);
              }}
            />
          </SettingsTarget>
          <SettingsTarget item={SPEND_ALERTS_SETTING}>
            <ConfigureRow
              icon={Wallet}
              title={t(SPEND_ALERTS_SETTING.label)}
              onPress={() => {
                router.push('/(app)/(tabs)/(3_profile)/spend-alerts' as Href);
              }}
            />
          </SettingsTarget>
        </RowGroup>
      </SettingsSearchScrollView>
    </View>
  );
}
