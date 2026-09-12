import { type TFunction } from 'i18next';
import { type ReactNode, useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { FlatList, I18nManager, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { QueryError } from '@/components/query-error';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Mic, SearchX } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { LANGUAGE_ENDONYMS, LANGUAGE_ENGLISH_NAMES, SUPPORTED_LANGUAGES } from '@/i18n/languages';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  reconcileVoiceInputLanguageTag,
  voiceInputLanguageDisplayName,
} from '@/lib/voice-input/voice-input-language';
import {
  useVoiceInputLanguage,
  useVoiceInputLanguageLoaded,
  writeVoiceInputLanguage,
} from '@/lib/voice-input/voice-input-language-preference';
import { useGatewayTranscriptionPreference } from '@/lib/voice-input/gateway/gateway-transcription-preference';
import { useVoiceRecognitionLanguages } from '@/lib/voice-input/use-voice-recognition-languages';

const SEARCH_RTL = { textAlign: 'right' } as const;

// Static skeleton rows: count and shape match the real ChoiceRow rows (name
// line + caption; the trailing check is transparent unless selected, so the
// skeleton carries no trailing control) so the swap never moves layout and
// never shows a shape the loaded row will not have.
const SKELETON_ROW_COUNT = 6;

function SkeletonRows() {
  return (
    <View className="px-4 pb-4 pt-1">
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
        // eslint-disable-next-line react/no-array-index-key -- static skeleton rows, no reordering
        <View key={index} className="min-h-11 flex-row items-center justify-between py-3">
          <View className="flex-1 gap-1.5 pr-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-28" />
          </View>
        </View>
      ))}
    </View>
  );
}

type VoiceLanguageOption = {
  /** `null` is the Automatic row: resolve the tag from the app and device. */
  tag: string | null;
  label: string;
  description: string;
};

function automaticOption(t: TFunction): VoiceLanguageOption {
  return {
    tag: null,
    label: t('voiceLanguage.automatic'),
    // Automatic resolves from the active app language and the device's
    // locales, so the device wording names what the row actually does.
    description: t('language.deviceLanguage'),
  };
}

function matchesQuery(option: VoiceLanguageOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return (
    option.label.toLowerCase().includes(needle) || option.description.toLowerCase().includes(needle)
  );
}

function VoiceLanguageList({
  options,
  chosen,
  query,
  onSelect,
}: Readonly<{
  options: VoiceLanguageOption[];
  chosen: string | null;
  query: string;
  onSelect: (tag: string | null) => void;
}>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const filtered = options.filter(option => matchesQuery(option, query));

  if (filtered.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title={t('language.noMatches')}
        description={t('agents.sessionList.tryDifferentSearch')}
      />
    );
  }

  return (
    <FlatList
      className="flex-1 bg-background"
      data={filtered}
      keyExtractor={option => option.tag ?? 'automatic'}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerClassName="px-4 pb-4"
      ListFooterComponent={<View style={{ height: insets.bottom }} pointerEvents="none" />}
      renderItem={({ item, index }) => (
        <ChoiceRow
          label={item.label}
          description={item.description}
          className={index < filtered.length - 1 ? 'border-b-[0.5px] border-hair-soft' : undefined}
          selected={chosen === item.tag}
          onPress={() => {
            onSelect(item.tag);
          }}
        />
      )}
    />
  );
}

/**
 * Device-mode body. Split from the sheet so `useVoiceRecognitionLanguages` —
 * and therefore the locale fetch — only runs while the gateway transcription
 * switch is off. The gateway list is static and must not trigger a fetch.
 */
function DeviceVoiceLanguages({
  chosen,
  query,
  onSelect,
}: Readonly<{
  chosen: string | null;
  query: string;
  onSelect: (tag: string | null) => void;
}>) {
  const { t } = useTranslation();
  const { languages, isLoading, isError, refetch } = useVoiceRecognitionLanguages();

  if (isLoading) {
    return <SkeletonRows />;
  }
  if (isError) {
    // Retryable: the service call failed, so a retry can succeed.
    return <QueryError title={t('voiceLanguage.loadFailed')} onRetry={refetch} />;
  }
  if (languages.length === 0) {
    // Non-retryable: the service answered with zero supported languages, and
    // retrying cannot make it report languages it does not have.
    return (
      <EmptyState
        icon={Mic}
        title={t('voiceLanguage.emptyTitle')}
        description={t('voiceLanguage.emptyDescription')}
      />
    );
  }

  const options: VoiceLanguageOption[] = [
    automaticOption(t),
    ...languages.map(tag => ({
      tag,
      label: voiceInputLanguageDisplayName(tag),
      description: tag,
    })),
  ];
  // The stored tag may have been chosen in gateway mode (an app language), so
  // map it onto the device's locales before checking a row: otherwise no row
  // is checked while the settings row still names a language.
  return (
    <VoiceLanguageList
      options={options}
      chosen={reconcileVoiceInputLanguageTag(chosen, languages)}
      query={query}
      onSelect={onSelect}
    />
  );
}

/**
 * Picks the voice-input language. In gateway mode the choices are the app's
 * supported languages with no fetch; in device mode they are the recognition
 * service's locales. Writes the SecureStore-backed store directly — no picker
 * bridge — and dismisses on selection, mirroring the model picker's route
 * shell.
 */
export function VoiceLanguagePickerSheet() {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const { gatewayTranscriptionEnabled, hasLoaded: gatewayTranscriptionLoaded } =
    useGatewayTranscriptionPreference();
  const chosen = useVoiceInputLanguage();
  const chosenLoaded = useVoiceInputLanguageLoaded();
  const [query, setQuery] = useState('');
  const isRtl = I18nManager.isRTL;

  const onSelect = useCallback(
    (tag: string | null) => {
      writeVoiceInputLanguage(tag);
      router.back();
    },
    [router]
  );

  // The SecureStore reads resolve after mount; until both settle the mode and
  // the current check are unknown, so hold the skeletons (same row height as
  // ChoiceRow) and render the rows once, correctly checked. The device-mode
  // body is only mounted when the gateway switch is off, so the locale fetch
  // never runs in gateway mode.
  let content: ReactNode = <SkeletonRows />;
  if (gatewayTranscriptionLoaded && chosenLoaded) {
    if (gatewayTranscriptionEnabled) {
      const options: VoiceLanguageOption[] = [
        automaticOption(t),
        ...SUPPORTED_LANGUAGES.map(tag => ({
          tag,
          label: LANGUAGE_ENDONYMS[tag],
          description: LANGUAGE_ENGLISH_NAMES[tag],
        })),
      ];
      content = (
        <VoiceLanguageList
          options={options}
          chosen={reconcileVoiceInputLanguageTag(chosen, SUPPORTED_LANGUAGES)}
          query={query}
          onSelect={onSelect}
        />
      );
    } else {
      content = <DeviceVoiceLanguages chosen={chosen} query={query} onSelect={onSelect} />;
    }
  }

  return (
    <PickerSheet
      title={t('voiceLanguage.title')}
      doneLabel={t('common.done')}
      onDone={() => {
        router.back();
      }}
      onCancel={() => {
        router.back();
      }}
      scrollable={false}
      headerContent={
        <View className="px-4 pb-2 pt-3">
          <TextInput
            accessibilityLabel={t('language.search')}
            // leading-[normal] so no lineHeight reaches the style: iOS otherwise
            // draws the placeholder below the typed text and clips it. min-h-*
            // sets the height without padding, so iOS centres the text rect.
            className="rounded-md border border-input bg-background px-3 min-h-[44px] text-sm leading-[normal] text-foreground"
            placeholder={t('language.search')}
            placeholderTextColor={colors.mutedForeground}
            // textAlign is applied inline, not via a class: NativeWind maps it
            // to a native prop for TextInput and crashes on it in this version.
            style={isRtl ? SEARCH_RTL : undefined}
            // Uncontrolled: iOS drops keystrokes when state drives `value`;
            // `onChangeText` only feeds the filter.
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            returnKeyType="search"
          />
        </View>
      }
    >
      {content}
    </PickerSheet>
  );
}
