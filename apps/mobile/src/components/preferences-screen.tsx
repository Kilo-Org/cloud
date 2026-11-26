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
import { PREFERENCES_HUB_SETTINGS } from '@/lib/settings-search/preference-sources';
import { ChatSyncSettingRow } from '@/components/chat/chat-sync-setting-row';

/**
 * Preferences hub: each group s1 split into a subpage is one navigation row
 * here. The rows are moved, not redesigned — the subpages hold every switch
 * and picker verbatim; this screen only routes to them.
 *
 * Every row is also wrapped in the search target the index names, so a search
 * result lands on the row instead of only opening this screen.
 *
 * The rows below the Appearance control carry their own section heading: they
 * lead to account and notification destinations, not to appearance settings.
 */
export function PreferencesScreen({ settingsTarget }: Readonly<{ settingsTarget?: string }>) {
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
            <SettingsTarget item={PREFERENCES_HUB_SETTINGS.general}>
              <ConfigureRow
                icon={SlidersHorizontal}
                title={t(PREFERENCES_HUB_SETTINGS.general.label)}
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/general' as Href);
                }}
              />
            </SettingsTarget>
            <SettingsTarget item={PREFERENCES_HUB_SETTINGS.voiceInput}>
              <ConfigureRow
                icon={Mic}
                title={t(PREFERENCES_HUB_SETTINGS.voiceInput.label)}
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/voice-input' as Href);
                }}
              />
            </SettingsTarget>
            <SettingsTarget item={PREFERENCES_HUB_SETTINGS.toolSummaryTranslation}>
              {/* This subtitle is a sentence whose tail names the failure
                  behaviour, and the English copy already fills three lines at
                  the compact column: a two-line cap cuts that tail off, so no
                  fixed count bounds the copy. */}
              <ConfigureRow
                icon={WandSparkles}
                title={t(PREFERENCES_HUB_SETTINGS.toolSummaryTranslation.label)}
                subtitle={t('preferences.toolSummaryTranslationSubtitle')}
                subtitleNumberOfLines="all"
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/tool-summary-translation' as Href);
                }}
              />
            </SettingsTarget>
          </RowGroup>
        </Section>

        <Section label={t(PREFERENCES_HUB_SETTINGS.appearance.label)}>
          <SettingsTarget
            item={PREFERENCES_HUB_SETTINGS.appearance}
            targetIds={[
              PREFERENCES_HUB_SETTINGS.appearanceSystem.id,
              PREFERENCES_HUB_SETTINGS.appearanceLight.id,
              PREFERENCES_HUB_SETTINGS.appearanceDark.id,
            ]}
          >
            <SegmentedControl<ThemePreference>
              accessibilityLabel={t(PREFERENCES_HUB_SETTINGS.appearance.label)}
              options={[
                { value: 'system', label: t(PREFERENCES_HUB_SETTINGS.appearanceSystem.label) },
                { value: 'light', label: t(PREFERENCES_HUB_SETTINGS.appearanceLight.label) },
                { value: 'dark', label: t(PREFERENCES_HUB_SETTINGS.appearanceDark.label) },
              ]}
              value={themePreference}
              onChange={setThemePreference}
            />
          </SettingsTarget>
        </Section>

        <SettingsTarget item={PREFERENCES_HUB_SETTINGS.chatSync}>
          <ChatSyncSettingRow />
        </SettingsTarget>

        <Section label={t('preferences.accountNotifications')}>
          <RowGroup leadingTile>
            <SettingsTarget item={PREFERENCES_HUB_SETTINGS.account}>
              <ConfigureRow
                icon={Globe}
                title={t(PREFERENCES_HUB_SETTINGS.account.label)}
                subtitle={t('preferences.accountSubtitle')}
                subtitleNumberOfLines={2}
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/account' as Href);
                }}
              />
            </SettingsTarget>
            <SettingsTarget item={PREFERENCES_HUB_SETTINGS.notifications}>
              <ConfigureRow
                icon={Bell}
                title={t(PREFERENCES_HUB_SETTINGS.notifications.label)}
                subtitle={t('preferences.notificationsSubtitle')}
                onPress={() => {
                  router.push('/(app)/notifications' as Href);
                }}
              />
            </SettingsTarget>
            <SettingsTarget item={PREFERENCES_HUB_SETTINGS.notificationHistory}>
              <ConfigureRow
                icon={History}
                title={t(PREFERENCES_HUB_SETTINGS.notificationHistory.label)}
                subtitle={t('notifications.history.subtitle')}
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/notification-history' as Href);
                }}
              />
            </SettingsTarget>
            <SettingsTarget item={PREFERENCES_HUB_SETTINGS.spendAlerts}>
              <ConfigureRow
                icon={Wallet}
                title={t(PREFERENCES_HUB_SETTINGS.spendAlerts.label)}
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/spend-alerts' as Href);
                }}
              />
            </SettingsTarget>
          </RowGroup>
        </Section>
      </SettingsSearchScrollView>
    </View>
  );
}
