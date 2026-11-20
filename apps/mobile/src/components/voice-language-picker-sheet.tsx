import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { type TFunction } from 'i18next';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { QueryError } from '@/components/query-error';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Mic, SearchX } from '@/components/ui/icons';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { SearchField } from '@/components/ui/search-field';
import { foldForSearch } from '@/i18n/fold-for-search';
import { languageRows } from '@/i18n/language-rows';
import { SUPPORTED_LANGUAGES } from '@/i18n/languages';
import { getResolvedLanguage } from '@/lib/hooks/use-language-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { dismissSearchPickerKeyboard, SEARCHABLE_PICKER_LIST_PROPS } from '@/lib/picker-list';
import { useSideInsetMarginStyle, useSideInsetStyle } from '@/lib/screen-insets';
import {
  reconcileVoiceInputLanguageTag,
  voiceInputLanguageDisplayName,
  voiceInputLanguageEnglishName,
  voiceInputLanguageLocalizedName,
} from '@/lib/voice-input/voice-input-language';
import {
  useVoiceInputLanguage,
  useVoiceInputLanguageLoaded,
  writeVoiceInputLanguage,
} from '@/lib/voice-input/voice-input-language-preference';
import { useGatewayTranscriptionPreference } from '@/lib/voice-input/gateway/gateway-transcription-preference';
import { useVoiceRecognitionLanguages } from '@/lib/voice-input/use-voice-recognition-languages';

// The picker sheet renders its own scroll container (`scrollable={false}`), so
// the list fills the sheet's body. Rows own the page gutter, so the list adds
// none of its own.
const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = { paddingBottom: 16 } satisfies ViewStyle;

// Static skeleton rows: count and shape match the real ChoiceRow rows so the
// swap never moves layout and never shows a shape the loaded row will not have.
const SKELETON_ROW_COUNT = 6;

function SkeletonRows() {
  const sideInsetStyle = useSideInsetStyle();
  return (
    <View className="pt-1" style={sideInsetStyle}>
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
        <RowSkeleton
          // eslint-disable-next-line react/no-array-index-key -- static skeleton rows, no reordering
          key={index}
          subtitle
          className={index < SKELETON_ROW_COUNT - 1 ? 'border-b-[0.5px] border-hair-soft' : ''}
        />
      ))}
    </View>
  );
}

type VoiceLanguageOption = {
  /** `null` is the Automatic row: resolve the tag from the app and device. */
  tag: string | null;
  label: string;
  description: string;
  /** Extra terms the search matches, e.g. the English name in device mode. */
  searchTerms: readonly string[];
};

function automaticOption(t: TFunction): VoiceLanguageOption {
  return {
    tag: null,
    label: t('voiceLanguage.automatic'),
    // Automatic resolves from the active app language and the device's
    // locales, so the device wording names what the row actually does.
    description: t('language.deviceLanguage'),
    searchTerms: [],
  };
}

function matchesQuery(option: VoiceLanguageOption, query: string): boolean {
  // Fold like the app language picker so "espanol" finds "Español".
  const needle = foldForSearch(query.trim());
  if (needle.length === 0) {
    return true;
  }
  return [option.label, option.description, ...option.searchTerms].some(value =>
    foldForSearch(value).includes(needle)
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
  const colors = useThemeColors();
  const sideInsetMarginStyle = useSideInsetMarginStyle();
  const listRef = useRef<FlashListRef<VoiceLanguageOption>>(null);
  // `matchesQuery` folds the label, the description and every search term of
  // every option, so the filter only reruns when the option array or the query
  // changes. An unrelated parent re-render then hands the list the same `data`
  // identity and no mounted row re-renders.
  const filtered = useMemo(
    () => options.filter(option => matchesQuery(option, query)),
    [options, query]
  );
  // A query change draws a shorter list under the current offset, so a deep
  // scroll would leave the matching rows above the viewport.
  // `repository-rows-list` carries the same reset.
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [query]);

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
    <FlashList<VoiceLanguageOption>
      nestedScrollEnabled
      ref={listRef}
      style={[listStyle, { backgroundColor: colors.background }, sideInsetMarginStyle]}
      contentContainerStyle={listContentContainerStyle}
      data={filtered}
      // FlashList stores its props during render and can index `data` past its
      // end for a render React discarded; the fallback is the one FlashList
      // uses when the callback is absent (see the model picker's comment).
      keyExtractor={(option: VoiceLanguageOption | undefined, index) =>
        option?.tag ?? String(index)
      }
      maintainVisibleContentPosition={{ disabled: true }}
      {...SEARCHABLE_PICKER_LIST_PROPS}
      ListFooterComponent={<View style={{ height: insets.bottom }} pointerEvents="none" />}
      renderItem={({ item, index }: { item: VoiceLanguageOption | undefined; index: number }) =>
        // A stale index past the end of the rows (the model picker's
        // renderItem carries the same guard for the same reason).
        item ? (
          <ChoiceRow
            label={item.label}
            description={item.description}
            className={
              index < filtered.length - 1 ? 'border-b-[0.5px] border-hair-soft' : undefined
            }
            selected={chosen === item.tag}
            onPress={() => {
              onSelect(item.tag);
            }}
          />
        ) : null
      }
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

  // The fetched locale list is stable while the result stands, so the row
  // objects (endonyms plus the English and UI-language search terms) are
  // built once per list instead of on every render. Built above the early
  // returns so the hook order is identical in every state. The UI language is
  // read before the memo so the dep is the value: a language change rebuilds
  // the list.
  const uiLanguage = getResolvedLanguage();
  const options = useMemo<VoiceLanguageOption[]>(
    () => [
      automaticOption(t),
      ...languages.map(tag => {
        const englishName = voiceInputLanguageEnglishName(tag);
        const localizedName = voiceInputLanguageLocalizedName(tag, uiLanguage);
        const searchTerms = [englishName, localizedName].filter(
          (name): name is string => name !== undefined
        );
        return {
          tag,
          label: voiceInputLanguageDisplayName(tag),
          description: tag,
          // The endonym and the tag are already searchable; the English name
          // and the UI language's own name are what a user who does not read
          // the native name will type.
          searchTerms,
        };
      }),
    ],
    [t, languages, uiLanguage]
  );

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
  const { gatewayTranscriptionEnabled, hasLoaded: gatewayTranscriptionLoaded } =
    useGatewayTranscriptionPreference();
  const chosen = useVoiceInputLanguage();
  const chosenLoaded = useVoiceInputLanguageLoaded();
  const [query, setQuery] = useState('');

  const onSelect = useCallback(
    (tag: string | null) => {
      dismissSearchPickerKeyboard();
      writeVoiceInputLanguage(tag);
      router.back();
    },
    [router]
  );

  // The canonical app language picker's list: every supported language collated
  // by endonym, with the English name as the secondary line. `languageRows('')`
  // reads the resolved UI language so the search terms carry that language's
  // generated names. The UI language is read before the memo so the dep is the
  // value: a language change rebuilds the list. Memoized above the branch
  // because a hook cannot be called conditionally; the device branch builds
  // its own list from the fetched locales.
  const uiLanguage = getResolvedLanguage();
  const gatewayOptions = useMemo<VoiceLanguageOption[]>(
    () => [
      automaticOption(t),
      ...languageRows('', uiLanguage).map(row => ({
        tag: row.tag,
        label: row.endonym,
        description: row.englishName,
        // The row already shows the endonym and English name; the generated
        // UI-language name and the tag are searchable too, so "Arabisch" and
        // "zh-Hant" find a language whose endonym the user cannot type.
        searchTerms: [row.tag, ...row.searchNames],
      })),
    ],
    [t, uiLanguage]
  );

  // The SecureStore reads resolve after mount; until both settle the mode and
  // the current check are unknown, so hold the skeletons (same row height as
  // ChoiceRow) and render the rows once, correctly checked. The device-mode
  // body is only mounted when the gateway switch is off, so the locale fetch
  // never runs in gateway mode.
  let content: ReactNode = <SkeletonRows />;
  if (gatewayTranscriptionLoaded && chosenLoaded) {
    content = gatewayTranscriptionEnabled ? (
      <VoiceLanguageList
        options={gatewayOptions}
        chosen={reconcileVoiceInputLanguageTag(chosen, SUPPORTED_LANGUAGES)}
        query={query}
        onSelect={onSelect}
      />
    ) : (
      <DeviceVoiceLanguages chosen={chosen} query={query} onSelect={onSelect} />
    );
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
        // Uncontrolled: iOS drops keystrokes when state drives `value`;
        // `onChangeText` only feeds the filter.
        <SearchField
          className="mx-4 my-3"
          placeholder={t('language.search')}
          hasText={query !== ''}
          onChangeText={setQuery}
        />
      }
    >
      {content}
    </PickerSheet>
  );
}
