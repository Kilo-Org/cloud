import { type Href, useRouter } from 'expo-router';
import {
  Bell,
  Brain,
  CornerDownLeft,
  Cpu,
  Globe,
  MessageSquare,
  Mic,
  Shield,
  Smartphone,
} from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AppUnlockFeedback } from '@/components/app-unlock-screen';
import { FeatureFlagsSection } from '@/components/feature-flags-section';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ConfigureRow } from '@/components/ui/configure-row';
import { PreferenceRow } from '@/components/ui/preference-row';
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
import { LANGUAGE_ENDONYMS } from '@/i18n/languages';
import { setLanguagePickerBridge } from '@/lib/picker-bridge';
import {
  useGatewayTranscriptionModel,
  useGatewayTranscriptionPreference,
} from '@/lib/voice-input/gateway/gateway-transcription-preference';
import {
  setThemePreference,
  type ThemePreference,
  useThemePreference,
} from '@/lib/hooks/use-theme-preference';

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
  const {
    gatewayTranscriptionEnabled,
    hasLoaded: gatewayTranscriptionLoaded,
    setGatewayTranscriptionEnabled,
  } = useGatewayTranscriptionPreference();
  const storedTranscriptionModel = useGatewayTranscriptionModel();
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
        <PreferenceRow
          icon={Mic}
          title={t('preferences.gatewayTranscription')}
          subtitle={t('preferences.gatewayTranscriptionSubtitle')}
          value={gatewayTranscriptionEnabled}
          disabled={!gatewayTranscriptionLoaded}
          onValueChange={setGatewayTranscriptionEnabled}
        />
        {/* Model choice only matters while gateway transcription is on, so the
            row stays disabled — and its chevron hidden — when the switch is
            off. The caption follows the same rule: with the switch off no
            gateway model applies, so the row shows the empty caption even
            when a model is still stored for when the switch turns on. With no
            stored choice the gateway's first catalogue model is the default. */}
        <ConfigureRow
          icon={Cpu}
          title={t('preferences.transcriptionModel')}
          subtitle={
            (gatewayTranscriptionEnabled ? storedTranscriptionModel?.name : null) ??
            t('transcriptionModel.noneChosen')
          }
          className="rounded-lg bg-secondary px-3"
          disabled={!gatewayTranscriptionEnabled}
          onPress={() => {
            router.push('/(app)/transcription-model-picker' as Href);
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
