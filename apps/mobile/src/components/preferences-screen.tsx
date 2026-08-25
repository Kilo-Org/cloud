import { type Href, useRouter } from 'expo-router';
import { Bell, Brain, Globe, type LucideIcon, Smartphone } from '@/components/ui/icons';
import { useState } from 'react';
import { Switch, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { LanguagePickerSheet } from '@/components/language-picker-sheet';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ConfigureRow } from '@/components/ui/configure-row';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import { attemptPushRegistrationReconciliation } from '@/lib/auth/push-registration-reconciliation';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { getResolvedLanguage, useLanguagePreference } from '@/lib/hooks/use-language-preference';
import { useKeepScreenOnPreference } from '@/lib/hooks/use-keep-screen-on-preference';
import { useReasoningPreference } from '@/lib/hooks/use-reasoning-preference';
import { cn } from '@/lib/utils';
import { LANGUAGE_ENDONYMS } from '@/i18n/languages';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  setThemePreference,
  type ThemePreference,
  useThemePreference,
} from '@/lib/hooks/use-theme-preference';

type PreferenceRowProps = Readonly<{
  icon: LucideIcon;
  title: string;
  subtitle: string;
  value: boolean;
  disabled: boolean;
  onValueChange: (next: boolean) => void;
}>;

/** Switch row shaped like the Notifications category row. */
function PreferenceRow({
  icon: Icon,
  title,
  subtitle,
  value,
  disabled,
  onValueChange,
}: PreferenceRowProps) {
  const colors = useThemeColors();
  return (
    <View className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3">
      <Icon size={18} color={colors.secondaryForeground} />
      <View className="flex-1">
        {/* Disabled cue is the muted title, not row opacity — see the same
            pattern in notifications-screen's CategoryRow. */}
        <Text className={cn('text-sm font-medium', disabled && 'text-muted-foreground')}>
          {title}
        </Text>
        <Text variant="muted" className="mt-0.5 text-xs">
          {subtitle}
        </Text>
      </View>
      <Switch
        value={value}
        disabled={disabled}
        accessibilityLabel={title}
        accessibilityState={{ disabled }}
        onValueChange={onValueChange}
      />
    </View>
  );
}

export function PreferencesScreen() {
  const router = useRouter();
  const { preference: themePreference } = useThemePreference();
  const {
    defaultExpanded,
    hasLoaded: reasoningLoaded,
    setDefaultExpanded,
  } = useReasoningPreference();
  const {
    keepScreenOn,
    hasLoaded: keepScreenOnLoaded,
    setKeepScreenOn,
  } = useKeepScreenOnPreference();
  const { t } = useTranslation();
  const { userId } = useCurrentUserId();
  const { preference: languagePreference } = useLanguagePreference();
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const languageEndonym = LANGUAGE_ENDONYMS[getResolvedLanguage()];
  const languageSubtitle =
    languagePreference === 'device'
      ? `${t('common.device')} · ${languageEndonym}`
      : languageEndonym;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('preferences.title')} />
      <TabScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-3 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <PreferenceRow
          icon={Brain}
          title={t('preferences.autoExpandThinking')}
          subtitle={t('preferences.autoExpandThinkingSubtitle')}
          value={defaultExpanded}
          disabled={!reasoningLoaded}
          onValueChange={setDefaultExpanded}
        />
        <PreferenceRow
          icon={Smartphone}
          title={t('preferences.keepScreenOn')}
          subtitle={t('preferences.keepScreenOnSubtitle')}
          value={keepScreenOn}
          disabled={!keepScreenOnLoaded}
          onValueChange={setKeepScreenOn}
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

        {/* Account */}
        <View className="mt-3 gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('preferences.account')}
          </Text>
          <ConfigureRow
            icon={Globe}
            title={t('common.language')}
            subtitle={languageSubtitle}
            className="rounded-lg bg-secondary px-3"
            onPress={() => {
              setLanguagePickerOpen(true);
            }}
          />
          <ConfigureRow
            icon={Smartphone}
            title={t('profile.deviceSessions')}
            subtitle={t('profile.deviceSessionsSubtitle')}
            className="rounded-lg bg-secondary px-3"
            last
            onPress={() => {
              router.push('/(app)/device-sessions' as Href);
            }}
          />
        </View>

        {/* Notifications */}
        <View className="mt-3 gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('preferences.notifications')}
          </Text>
          <ConfigureRow
            icon={Bell}
            title={t('preferences.notifications')}
            subtitle={t('preferences.notificationsSubtitle')}
            className="rounded-lg bg-secondary px-3"
            last
            onPress={() => {
              router.push('/(app)/(tabs)/(3_profile)/notifications' as Href);
            }}
          />
        </View>
      </TabScreenScrollView>
      <LanguagePickerSheet
        visible={languagePickerOpen}
        onClose={() => {
          setLanguagePickerOpen(false);
        }}
        onApplied={() => {
          if (userId) {
            void attemptPushRegistrationReconciliation(userId);
          }
        }}
        returnTarget="preferences"
      />
    </View>
  );
}
