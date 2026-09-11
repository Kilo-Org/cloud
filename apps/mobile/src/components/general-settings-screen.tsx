import { Brain, CornerDownLeft, MessageSquare, Shield, Smartphone } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AppUnlockFeedback } from '@/components/app-unlock-screen';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { PreferenceRow } from '@/components/ui/preference-row';
import { useAppUnlock } from '@/lib/app-unlock-context';
import { useKeepScreenOnPreference } from '@/lib/hooks/use-keep-screen-on-preference';
import { usePrReviewFooterPreference } from '@/lib/hooks/use-pr-review-footer-preference';
import { useReasoningPreference } from '@/lib/hooks/use-reasoning-preference';
import { useReturnSendsMessagePreference } from '@/lib/hooks/use-return-sends-message-preference';

/**
 * General settings subpage. Rows are moved verbatim from the former
 * PreferencesScreen (slice s1 is a move only, no behavior change): every label,
 * subtitle, disabled condition, default, and effect is unchanged.
 */
export function GeneralSettingsScreen() {
  const unlock = useAppUnlock();
  const { setEnabled: handleUnlockChange } = unlock;
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

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('preferences.general')} />
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
      </TabScreenScrollView>
    </View>
  );
}
