import { reloadAppAsync } from 'expo';
import { useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, I18nManager, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { LanguagePickerRow } from '@/components/language-picker-row';
import { PickerSheet } from '@/components/picker-sheet';
import { SearchX } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { applyLanguagePreference } from '@/i18n/apply-language';
import { languagePickerItems } from '@/i18n/language-rows';
import { LANGUAGE_ENDONYMS, type SupportedLanguage } from '@/i18n/languages';
import { resolveDeviceLanguage } from '@/i18n/resolve-language';
import { isRtlLanguage } from '@/i18n/rtl';
import { type LanguageReturnTarget } from '@/i18n/return-target';
import {
  getLanguagePreference,
  getResolvedLanguage,
  type LanguagePreference,
} from '@/lib/hooks/use-language-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { usePreventRemove } from '@/lib/navigation/prevent-remove';

const SEARCH_RTL = { textAlign: 'right' } as const;

export function LanguagePickerSheet({
  onClose,
  onApplied,
  returnTarget,
  beforeReload,
}: Readonly<{
  onClose: () => void;
  onApplied?: () => void;
  returnTarget: LanguageReturnTarget;
  beforeReload?: () => Promise<void>;
}>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const [selected, setSelected] = useState<LanguagePreference>('device');
  const [applied, setApplied] = useState<LanguagePreference>('device');
  const [appliedLanguage, setAppliedLanguage] = useState<SupportedLanguage>('en');
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const [query, setQuery] = useState('');
  // Bumped on every focus so the uncontrolled TextInput remounts empty.
  const [searchEpoch, setSearchEpoch] = useState(0);
  const skipNextGuardRef = useRef(false);
  const navigation = useNavigation();

  // While an apply is in flight — busy, restarting, or the reload has failed
  // and Retry is up — a swipe-dismiss or back would close the sheet mid-change.
  // Block every removal; the applied-ltr path flips skipNextGuardRef just before
  // closing so its own navigation is replayed instead of blocked.
  usePreventRemove(busy || restarting || reloadFailed, ({ data }) => {
    if (skipNextGuardRef.current) {
      skipNextGuardRef.current = false;
      navigation.dispatch(data.action);
    }
    // Otherwise leave the sheet: swipe and back do not apply the change.
  });

  useFocusEffect(
    useCallback(() => {
      setQuery('');
      setSearchEpoch(epoch => epoch + 1);
      setSelected(getLanguagePreference());
      setApplied(getLanguagePreference());
      setAppliedLanguage(getResolvedLanguage());
      setBusy(false);
      setRestarting(false);
      setReloadFailed(false);
    }, [])
  );

  const deviceEndonym = LANGUAGE_ENDONYMS[resolveDeviceLanguage()];
  // The native layout direction, not the catalog's: the row insets and the
  // search alignment follow how the interface is laid out.
  const isRtl = I18nManager.isRTL;
  const items = languagePickerItems(query, appliedLanguage, applied === 'device');

  const handleDone = async (preference = selected) => {
    if (busy) {
      return;
    }
    const resolved = preference === 'device' ? resolveDeviceLanguage() : preference;
    if (I18nManager.isRTL !== isRtlLanguage(resolved)) {
      setRestarting(true);
    }
    setBusy(true);
    const outcome = await applyLanguagePreference(preference, resolved, returnTarget, beforeReload);
    // `ApplyLanguageOutcome` is a closed union and every kind is handled
    // above, so no `default` branch is reachable.
    // eslint-disable-next-line default-case
    switch (outcome.kind) {
      case 'applied-ltr': {
        // Release the guard first: it reads its flag through a ref that only
        // commits after this render, so setBusy(false) alone would still block
        // the onClose navigation below.
        skipNextGuardRef.current = true;
        setBusy(false);
        onApplied?.();
        onClose();
        break;
      }
      case 'restarting-rtl': {
        // reloadAppAsync succeeded; the native reload wipes this state.
        break;
      }
      case 'reload-failed': {
        setBusy(false);
        setRestarting(false);
        setReloadFailed(true);
        break;
      }
      case 'persist-failed': {
        // setAsync already toasts the failure; keep the current language.
        setBusy(false);
        setRestarting(false);
        break;
      }
      case 'catalog-failed': {
        toast.error(t('language.catalogLoadFailed'));
        setBusy(false);
        break;
      }
    }
  };

  const retryReload = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await reloadAppAsync();
    } catch {
      setBusy(false);
    }
  };

  if (reloadFailed) {
    return (
      <PickerSheet
        title={t('language.couldNotRestart')}
        onDone={() => {
          void retryReload();
        }}
        doneLabel={t('common.retry')}
        disabled={busy}
        scrollable={false}
      >
        <View className="items-center gap-3 px-6 py-8">
          <Text variant="muted" className="text-center">
            {t('language.languageSaved')}
          </Text>
        </View>
      </PickerSheet>
    );
  }
  if (restarting) {
    return (
      <PickerSheet
        title={t('language.title')}
        onDone={() => {
          // Restarting: the native reload replaces this sheet.
        }}
        onCancel={() => {
          // Restarting: the native reload replaces this sheet.
        }}
        doneLabel={t('common.done')}
        disabled
        scrollable={false}
      >
        <View className="items-center gap-3 px-6 py-8">
          <ActivityIndicator color={colors.mutedForeground} />
          <Text variant="muted" className="text-center">
            {t('language.restarting')}
          </Text>
        </View>
      </PickerSheet>
    );
  }
  return (
    <PickerSheet
      title={t('language.title')}
      onDone={() => {
        void handleDone();
      }}
      onCancel={onClose}
      doneLabel={t('common.done')}
      disabled={busy}
      scrollable={false}
    >
      <FlatList
        className="flex-1 bg-background"
        data={items}
        keyExtractor={item => item.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerClassName="px-4 pb-4"
        ListFooterComponent={<View style={{ height: insets.bottom }} pointerEvents="none" />}
        ListHeaderComponent={
          <View className="pb-2 pt-3">
            <TextInput
              key={searchEpoch}
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
              // Uncontrolled: iOS drops keystrokes when state drives `value`. The
              // input remounts on focus via `searchEpoch`, so a reopen starts empty.
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              clearButtonMode="while-editing"
              returnKeyType="search"
            />
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            icon={SearchX}
            placement="top"
            title={t('language.noMatches')}
            description={t('agents.sessionList.tryDifferentSearch')}
          />
        }
        renderItem={({ item, index }) => (
          <LanguagePickerRow
            item={item}
            first={index === 0}
            showDivider={items[index + 1]?.kind !== 'section'}
            selected={selected}
            disabled={busy}
            deviceEndonym={deviceEndonym}
            isRtl={isRtl}
            onSelect={preference => {
              setSelected(preference);
              const resolved = preference === 'device' ? resolveDeviceLanguage() : preference;
              if (I18nManager.isRTL === isRtlLanguage(resolved)) {
                void handleDone(preference);
              }
            }}
          />
        )}
      />
    </PickerSheet>
  );
}
