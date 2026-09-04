import { type Href, useRouter } from 'expo-router';
import {
  Bell,
  Brain,
  CornerDownLeft,
  Globe,
  type LucideIcon,
  MessageSquare,
  Shield,
  Smartphone,
} from '@/components/ui/icons';
import { ActivityIndicator, Switch, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AppUnlockFeedback } from '@/components/app-unlock-screen';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ConfigureRow } from '@/components/ui/configure-row';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import { useAppUnlock } from '@/lib/app-unlock-context';
import { attemptPushRegistrationReconciliation } from '@/lib/auth/push-registration-reconciliation';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { getResolvedLanguage, useLanguagePreference } from '@/lib/hooks/use-language-preference';
import { useKeepScreenOnPreference } from '@/lib/hooks/use-keep-screen-on-preference';
import { usePrReviewFooterPreference } from '@/lib/hooks/use-pr-review-footer-preference';
import { useReasoningPreference } from '@/lib/hooks/use-reasoning-preference';
import { useReturnSendsMessagePreference } from '@/lib/hooks/use-return-sends-message-preference';
import { useTrustedHosts } from '@/lib/hooks/use-trusted-hosts';
import { cn } from '@/lib/utils';
import { LANGUAGE_ENDONYMS } from '@/i18n/languages';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { setLanguagePickerBridge } from '@/lib/picker-bridge';
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
  busy?: boolean;
  onValueChange: (next: boolean) => void;
}>;

/** Switch row shaped like the Notifications category row. */
function PreferenceRow({
  icon: Icon,
  title,
  subtitle,
  value,
  disabled,
  busy = false,
  onValueChange,
}: PreferenceRowProps) {
  const colors = useThemeColors();
  return (
    <View className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3">
      {busy ? (
        <ActivityIndicator size="small" color={colors.mutedForeground} />
      ) : (
        <Icon size={18} color={colors.secondaryForeground} />
      )}
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
        accessibilityState={{ disabled, busy }}
        onValueChange={onValueChange}
      />
    </View>
  );
}

export function PreferencesScreen() {
  const router = useRouter();
  const unlock = useAppUnlock();
  const { setEnabled: handleUnlockChange } = unlock;
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
  const {
    prReviewFooter,
    hasLoaded: prReviewFooterLoaded,
    setPrReviewFooter,
  } = usePrReviewFooterPreference();
  const { returnSendsMessage, hasLoaded, setReturnSendsMessage } =
    useReturnSendsMessagePreference();
  const { t } = useTranslation();
  const { userId } = useCurrentUserId();
  const { preference: languagePreference } = useLanguagePreference();
  const { hasLoaded: trustedHostsLoaded } = useTrustedHosts();
  const languageEndonym = LANGUAGE_ENDONYMS[getResolvedLanguage()];
  const languageSubtitle =
    languagePreference === 'device'
      ? `${t('common.device')} · ${languageEndonym}`
      : languageEndonym;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.preferences')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-6 gap-3 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-2">
          <PreferenceRow
            icon={Shield}
            title={t('preferences.biometricUnlock')}
            subtitle={t('preferences.biometricUnlockSubtitle')}
            value={unlock.enabled}
            disabled={unlock.busy || unlock.status !== 'unlocked'}
            busy={unlock.busy}
            onValueChange={handleUnlockChange}
          />
          <AppUnlockFeedback outcome={unlock.purpose === 'setting' ? unlock.outcome : null} />
        </View>
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
        <PreferenceRow
          icon={MessageSquare}
          title={t('preferences.prReviewAttribution')}
          subtitle={t('preferences.prReviewAttributionSubtitle')}
          value={prReviewFooter}
          disabled={!prReviewFooterLoaded}
          onValueChange={setPrReviewFooter}
        />
        <PreferenceRow
          icon={CornerDownLeft}
          title={t('preferences.returnSendsMessage')}
          subtitle={t('preferences.returnSendsMessageSubtitle')}
          value={returnSendsMessage}
          disabled={!hasLoaded}
          onValueChange={setReturnSendsMessage}
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
              setLanguagePickerBridge({
                onApplied: () => {
                  if (userId) {
                    void attemptPushRegistrationReconciliation(userId);
                  }
                },
              });
              router.push('/(app)/language-picker' as Href);
            }}
          />
          <ConfigureRow
            icon={Shield}
            title={t('trustedHosts.title')}
            subtitle={t('trustedHosts.subtitle')}
            className="rounded-lg bg-secondary px-3"
            disabled={!trustedHostsLoaded}
            onPress={() => {
              router.push('/(app)/(tabs)/(3_profile)/trusted-hosts' as Href);
            }}
          />
          <ConfigureRow
            icon={Smartphone}
            title={t('common.deviceSessions')}
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
            {t('common.notifications')}
          </Text>
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
        </View>
      </TabScreenScrollView>
    </View>
  );
}
