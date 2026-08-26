import { reloadAppAsync } from 'expo';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  FlatList,
  I18nManager,
  Modal,
  Platform,
  Pressable,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { AppAwareKeyboardPaddingView } from '@/components/kilo-chat/app-aware-keyboard-padding';
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

const SEARCH_RTL = { textAlign: 'right' } as const;

export function LanguagePickerSheet({
  visible,
  onClose,
  onApplied,
  returnTarget,
  beforeReload,
}: Readonly<{
  visible: boolean;
  onClose: () => void;
  onApplied?: () => void;
  returnTarget: LanguageReturnTarget;
  beforeReload?: () => Promise<void>;
}>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const [selected, setSelected] = useState<LanguagePreference>('device');
  // Captured when the sheet opens, never updated from `selected`: the groups
  // must describe what is applied, so tapping a row moves only the checkmark.
  const [applied, setApplied] = useState<LanguagePreference>('device');
  const [appliedLanguage, setAppliedLanguage] = useState<SupportedLanguage>('en');
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (visible) {
      setSelected(getLanguagePreference());
      setApplied(getLanguagePreference());
      setAppliedLanguage(getResolvedLanguage());
      setBusy(false);
      setRestarting(false);
      setReloadFailed(false);
      setQuery('');
    }
  }, [visible]);

  if (!visible) {
    return null;
  }

  const deviceEndonym = LANGUAGE_ENDONYMS[resolveDeviceLanguage()];
  // The native layout direction, not the catalog's: the row insets and the
  // search alignment follow how the interface is laid out.
  const isRtl = I18nManager.isRTL;
  const items = languagePickerItems(query, appliedLanguage, applied === 'device');

  const handleDone = async () => {
    if (busy) {
      return;
    }
    const resolved = selected === 'device' ? resolveDeviceLanguage() : selected;
    if (I18nManager.isRTL !== isRtlLanguage(resolved)) {
      setRestarting(true);
    }
    setBusy(true);
    const outcome = await applyLanguagePreference(selected, resolved, returnTarget, beforeReload);
    // `ApplyLanguageOutcome` is a closed union and every kind is handled
    // above, so no `default` branch is reachable.
    // eslint-disable-next-line default-case
    switch (outcome.kind) {
      case 'applied-ltr': {
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

  const renderSheetContent = () => {
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
        <View className="px-4 pb-2 pt-3">
          <TextInput
            accessibilityLabel={t('language.search')}
            // leading-[normal] so no lineHeight reaches the style: iOS otherwise
            // draws the placeholder below the typed text and clips it.
            className="rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-[normal] text-foreground"
            placeholder={t('language.search')}
            placeholderTextColor={colors.mutedForeground}
            // textAlign is applied inline, not via a class: NativeWind maps it
            // to a native prop for TextInput and crashes on it in this version.
            style={isRtl ? SEARCH_RTL : undefined}
            // Uncontrolled: iOS drops keystrokes when state drives `value`. The
            // sheet unmounts when hidden, so a reopen starts the field empty.
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            clearButtonMode="while-editing"
            returnKeyType="search"
          />
        </View>
        <FlatList
          data={items}
          keyExtractor={item => item.key}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerClassName="px-4 pb-4"
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
              onSelect={setSelected}
            />
          )}
        />
      </PickerSheet>
    );
  };

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (!busy && !reloadFailed) {
          onClose();
        }
      }}
    >
      <AppAwareKeyboardPaddingView
        // `bg-black/40` renders as nothing in this setup, so the scrim is a concrete 40% black.
        className="flex-1 justify-end bg-[#00000066]"
        keyboardOffset={Platform.OS === 'android' ? insets.bottom : 0}
      >
        <Pressable
          className="flex-1"
          accessibilityLabel={t('common.cancel')}
          onPress={() => {
            if (!busy && !reloadFailed) {
              onClose();
            }
          }}
        />
        <View
          accessibilityViewIsModal
          // One surface colour for header and body, and `overflow-hidden` so
          // the header's rule and the rows are clipped by the top radius.
          className="max-h-[80%] overflow-hidden rounded-t-3xl bg-background"
          style={{ paddingBottom: insets.bottom }}
        >
          <View className="items-center pt-2">
            <View className="h-1.5 w-10 rounded-full bg-muted-soft" />
          </View>
          {renderSheetContent()}
        </View>
      </AppAwareKeyboardPaddingView>
    </Modal>
  );
}
