import { type Href, useRouter } from 'expo-router';
import { Cpu, Globe, Mic } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ConfigureRow } from '@/components/ui/configure-row';
import { PreferenceRow } from '@/components/ui/preference-row';
import { Text } from '@/components/ui/text';
import { VoiceTestField } from '@/components/voice-test-field';
import { useOrganization } from '@/lib/organization-context';
import { useGatewayTranscriptionModelSelection } from '@/lib/voice-input/gateway/gateway-transcription-model-selection';
import { useGatewayTranscriptionPreference } from '@/lib/voice-input/gateway/gateway-transcription-preference';
import { voiceInputLanguageDisplayName } from '@/lib/voice-input/voice-input-language';
import {
  useVoiceInputLanguage,
  useVoiceInputLanguageLoaded,
} from '@/lib/voice-input/voice-input-language-preference';

/**
 * Neutral row value while the catalogue is missing (failed or empty). The
 * state block below carries the reason and the Retry, so the row must not
 * claim a selection nor repeat the failure copy.
 */
const NO_MODEL_VALUE = '—';

/**
 * Voice input settings subpage. The gateway switch is the s1 move; the model
 * row renders the live-selection states so "no model selected" is never a
 * present state while the switch is on.
 */
export function VoiceInputSettingsScreen() {
  const router = useRouter();
  const { organizationId } = useOrganization();
  const {
    gatewayTranscriptionEnabled,
    hasLoaded: gatewayTranscriptionLoaded,
    setGatewayTranscriptionEnabled,
  } = useGatewayTranscriptionPreference();
  const { status, model, isFetching, refetch } = useGatewayTranscriptionModelSelection(
    organizationId ?? undefined
  );
  const chosen = useVoiceInputLanguage();
  const languageLoaded = useVoiceInputLanguageLoaded();
  const { t } = useTranslation();

  // Only a live choice can open the picker; while off, loading, or without a
  // catalogue there is nothing to pick (retry lives in the state below).
  const modelRowDisabled =
    status === 'off' || status === 'loading' || status === 'error' || status === 'empty';

  let modelSubtitle = t('transcriptionModel.noneChosen');
  if (status === 'loading') {
    modelSubtitle = t('common.loading');
  } else if (status === 'error' || status === 'empty') {
    // The state block below is the single message for a missing catalogue, so
    // the row carries a neutral placeholder instead of repeating the failure.
    modelSubtitle = NO_MODEL_VALUE;
  } else if (status !== 'off' && model !== null) {
    // ready (auto-selected or kept) and unavailable (kept) both name the model
    // in effect so the row never reads as unset while the switch is on. While
    // off no model is in effect, so the row keeps the "None chosen" caption
    // instead of naming the catalogue's first entry.
    modelSubtitle = model.name;
  }

  // The stored tag is a BCP-47 value the picker wrote, so naming it by its
  // endonym reads like the picker rows. Until the SecureStore read resolves,
  // the row shows the loading caption instead of claiming "Automatic" for a
  // choice that may exist.
  let languageSubtitle = t('voiceLanguage.automatic');
  if (!languageLoaded) {
    languageSubtitle = t('common.loading');
  } else if (chosen) {
    languageSubtitle = voiceInputLanguageDisplayName(chosen);
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('preferences.voiceInput')} />
      <TabScreenScrollView
        automaticallyAdjustKeyboardInsets
        className="flex-1"
        contentContainerClassName="px-6 gap-3 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <PreferenceRow
          icon={Mic}
          title={t('preferences.gatewayTranscription')}
          subtitle={t('preferences.gatewayTranscriptionSubtitle')}
          value={gatewayTranscriptionEnabled}
          disabled={!gatewayTranscriptionLoaded}
          onValueChange={setGatewayTranscriptionEnabled}
        />
        <ConfigureRow
          icon={Cpu}
          title={t('preferences.transcriptionModel')}
          subtitle={modelSubtitle}
          className="rounded-lg bg-secondary px-3"
          disabled={modelRowDisabled}
          onPress={() => {
            router.push('/(app)/transcription-model-picker' as Href);
          }}
        />
        <ConfigureRow
          icon={Globe}
          title={t('common.language')}
          subtitle={languageSubtitle}
          className="rounded-lg bg-secondary px-3"
          last
          disabled={!languageLoaded}
          onPress={() => {
            router.push('/(app)/voice-language-picker' as Href);
          }}
        />
        {status === 'unavailable' ? (
          // A stored model the live catalogue dropped is kept (the engine still
          // has an id) but retry cannot restore it, so the enabled row above
          // opens the picker and this notice names that one action. It must not
          // reuse the dictation error copy, which sends the user to Preferences
          // while they are standing in them.
          <Text className="px-1 text-xs text-muted-foreground">
            {t('voiceInput.gatewayModelUnavailableNotice')}
          </Text>
        ) : null}
        {status === 'error' ? (
          <QueryError
            variant="server"
            placement="top"
            title={t('transcriptionModel.loadFailed')}
            onRetry={() => void refetch()}
            isRetrying={isFetching}
          />
        ) : null}
        {status === 'empty' ? (
          <QueryError
            placement="top"
            title={t('transcriptionModel.emptyTitle')}
            message={t('transcriptionModel.emptyDescription')}
            onRetry={() => void refetch()}
            isRetrying={isFetching}
          />
        ) : null}
        <VoiceTestField />
      </TabScreenScrollView>
    </View>
  );
}
