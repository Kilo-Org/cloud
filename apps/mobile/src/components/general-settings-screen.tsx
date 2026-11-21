import {
  Brain,
  CornerDownLeft,
  EyeOff,
  MessageSquare,
  Rows3,
  Shield,
  Smartphone,
} from '@/components/ui/icons';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useCallback } from 'react';
import { View } from 'react-native';

import { AppUnlockFeedback } from '@/components/app-unlock-screen';
import { ScreenHeader } from '@/components/screen-header';
import {
  SettingsSearchScrollView,
  SettingsTarget,
} from '@/components/settings-search/settings-target';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
import { useAppUnlock } from '@/lib/app-unlock-context';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useCondenseToolCallsPreference } from '@/lib/hooks/use-condense-tool-calls-preference';
import { useHideThinkingPreference } from '@/lib/hooks/use-hide-thinking-preference';
import { useKeepScreenOnPreference } from '@/lib/hooks/use-keep-screen-on-preference';
import { usePrReviewFooterPreference } from '@/lib/hooks/use-pr-review-footer-preference';
import { useReasoningPreference } from '@/lib/hooks/use-reasoning-preference';
import { useReturnSendsMessagePreference } from '@/lib/hooks/use-return-sends-message-preference';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import {
  APP_UNLOCK_SETTING,
  AUTO_EXPAND_THINKING_SETTING,
  CONDENSE_TOOL_CALLS_SETTING,
  HIDE_THINKING_SETTING,
  KEEP_SCREEN_ON_SETTING,
  PR_REVIEW_ATTRIBUTION_SETTING,
  RETURN_SENDS_MESSAGE_SETTING,
} from '@/lib/settings-search/preference-sources';

/**
 * General settings subpage. Rows are moved verbatim from the former
 * PreferencesScreen (slice s1 is a move only, no behavior change): every label,
 * subtitle, disabled condition, default, and effect is unchanged.
 *
 * Each switch is wrapped in the search target its index definition names, so a
 * search result reveals that row without flipping it.
 */
export function GeneralSettingsScreen({
  settingsTarget,
}: Readonly<{ settingsTarget?: string }>) {
  const unlock = useAppUnlock();
  const { setEnabled: handleUnlockChange } = unlock;
  const {
    defaultExpanded,
    hasLoaded: reasoningLoaded,
    setDefaultExpanded,
  } = useReasoningPreference();
  const {
    hideThinking,
    hasLoaded: hideThinkingLoaded,
    setHideThinking,
  } = useHideThinkingPreference();
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
    condenseToolCalls,
    hasLoaded: condenseToolCallsLoaded,
    setCondenseToolCalls,
  } = useCondenseToolCallsPreference();
  const { t } = useTranslation();

  // One enable attempt owns its feedback: leaving this screen retires it, so
  // a later visit shows no error until the user tries again.
  const { clearSettingOutcome } = unlock;
  useFocusEffect(
    useCallback(
      () => () => {
        clearSettingOutcome();
      },
      [clearSettingOutcome]
    )
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('preferences.general')} backFallback={PROFILE_TAB_HREF} />
      <SettingsSearchScrollView
        settingsTarget={settingsTarget}
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        <Section>
          <RowGroup>
            <SettingsTarget item={APP_UNLOCK_SETTING}>
              <PreferenceRow
                icon={Shield}
                title={t(APP_UNLOCK_SETTING.label)}
                subtitle={t('preferences.biometricUnlockSubtitle')}
                value={unlock.enabled}
                disabled={unlock.busy || unlock.status !== 'unlocked'}
                busy={unlock.busy}
                onValueChange={handleUnlockChange}
              />
            </SettingsTarget>
          </RowGroup>
          <AppUnlockFeedback outcome={unlock.purpose === 'setting' ? unlock.outcome : null} />
        </Section>
        <RowGroup>
          <SettingsTarget item={AUTO_EXPAND_THINKING_SETTING}>
            <PreferenceRow
              icon={Brain}
              title={t(AUTO_EXPAND_THINKING_SETTING.label)}
              subtitle={
                hideThinking
                  ? t('preferences.autoExpandThinkingInactiveSubtitle')
                  : t('preferences.autoExpandThinkingSubtitle')
              }
              inactiveSubtitle={
                hideThinking
                  ? t('preferences.autoExpandThinkingSubtitle')
                  : t('preferences.autoExpandThinkingInactiveSubtitle')
              }
              value={defaultExpanded}
              // The row states a dependency on the hide-thinking preference, so it
              // stays inert until both stored values are known.
              disabled={!reasoningLoaded || !hideThinkingLoaded || hideThinking}
              onValueChange={setDefaultExpanded}
            />
          </SettingsTarget>
          <SettingsTarget item={HIDE_THINKING_SETTING}>
            <PreferenceRow
              icon={EyeOff}
              title={t(HIDE_THINKING_SETTING.label)}
              subtitle={t('preferences.hideThinkingSubtitle')}
              value={hideThinking}
              disabled={!hideThinkingLoaded}
              onValueChange={setHideThinking}
            />
          </SettingsTarget>
          <SettingsTarget item={CONDENSE_TOOL_CALLS_SETTING}>
            <PreferenceRow
              icon={Rows3}
              title={t(CONDENSE_TOOL_CALLS_SETTING.label)}
              subtitle={t('preferences.condenseToolCallsSubtitle')}
              value={condenseToolCalls}
              disabled={!condenseToolCallsLoaded}
              onValueChange={setCondenseToolCalls}
            />
          </SettingsTarget>
          <SettingsTarget item={KEEP_SCREEN_ON_SETTING}>
            <PreferenceRow
              icon={Smartphone}
              title={t(KEEP_SCREEN_ON_SETTING.label)}
              subtitle={t('preferences.keepScreenOnSubtitle')}
              value={keepScreenOn}
              disabled={!keepScreenOnLoaded}
              onValueChange={setKeepScreenOn}
            />
          </SettingsTarget>
          <SettingsTarget item={PR_REVIEW_ATTRIBUTION_SETTING}>
            <PreferenceRow
              icon={MessageSquare}
              title={t(PR_REVIEW_ATTRIBUTION_SETTING.label)}
              subtitle={t('preferences.prReviewAttributionSubtitle')}
              value={prReviewFooter}
              disabled={!prReviewFooterLoaded}
              onValueChange={setPrReviewFooter}
            />
          </SettingsTarget>
          <SettingsTarget item={RETURN_SENDS_MESSAGE_SETTING}>
            <PreferenceRow
              icon={CornerDownLeft}
              title={t(RETURN_SENDS_MESSAGE_SETTING.label)}
              subtitle={t('preferences.returnSendsMessageSubtitle')}
              value={returnSendsMessage}
              disabled={!hasLoaded}
              onValueChange={setReturnSendsMessage}
            />
          </SettingsTarget>
        </RowGroup>
      </SettingsSearchScrollView>
    </View>
  );
}
