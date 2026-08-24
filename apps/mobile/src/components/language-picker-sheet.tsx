import { reloadAppAsync } from 'expo';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  FlatList,
  I18nManager,
  Modal,
  Pressable,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { PickerSheet } from '@/components/picker-sheet';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Text } from '@/components/ui/text';
import { applyLanguagePreference } from '@/i18n/apply-language';
import { languageRows } from '@/i18n/language-rows';
import { LANGUAGE_ENDONYMS } from '@/i18n/languages';
import { resolveDeviceLanguage } from '@/i18n/resolve-language';
import { isRtlLanguage } from '@/i18n/rtl';
import { type LanguageReturnTarget } from '@/i18n/return-target';
import {
  getLanguagePreference,
  getResolvedLanguage,
  type LanguagePreference,
} from '@/lib/hooks/use-language-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const ROW_LTR = { writingDirection: 'ltr' } as const;
const ROW_RTL = { writingDirection: 'rtl' } as const;

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
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (visible) {
      setSelected(getLanguagePreference());
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
  const isRtl = isRtlLanguage(getResolvedLanguage());
  const rows = languageRows(query, selected === 'device' ? undefined : selected);

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
        <View className="border-b border-border px-5 pb-3">
          <TextInput
            accessibilityLabel={t('language.search')}
            // leading-[normal] so no lineHeight reaches the style: iOS otherwise
            // draws the placeholder below the typed text and clips it.
            className="rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-[normal] text-foreground"
            placeholder={t('language.search')}
            placeholderTextColor={colors.mutedForeground}
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
          data={rows}
          keyExtractor={row => row.tag}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          className="max-h-[55vh]"
          contentContainerClassName="px-5 pb-4"
          ListHeaderComponent={
            query.length === 0 ? (
              <ChoiceRow
                selected={selected === 'device'}
                disabled={busy}
                onPress={() => {
                  setSelected('device');
                }}
              >
                <View className={`flex-1 ${isRtl ? 'pl-3' : 'pr-3'}`}>
                  <Text className="text-sm font-medium">{t('language.deviceLanguage')}</Text>
                  <Text variant="muted" className="mt-0.5 text-xs">
                    {deviceEndonym}
                  </Text>
                </View>
              </ChoiceRow>
            ) : null
          }
          ListEmptyComponent={
            <Text variant="muted" className="py-8 text-center text-sm">
              {t('language.noMatches')}
            </Text>
          }
          renderItem={({ item }) => (
            <ChoiceRow
              selected={selected === item.tag}
              disabled={busy}
              onPress={() => {
                setSelected(item.tag);
              }}
            >
              <View className={`flex-1 ${isRtl ? 'pl-3' : 'pr-3'}`}>
                {/* The row reads in its own script and its own direction. */}
                <Text
                  className="text-sm font-medium"
                  style={isRtlLanguage(item.tag) ? ROW_RTL : ROW_LTR}
                >
                  {item.endonym}
                </Text>
                <Text variant="muted" className="mt-0.5 text-xs">
                  {item.englishName}
                </Text>
              </View>
            </ChoiceRow>
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
      <View className="flex-1 justify-end bg-black/40">
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
          className="max-h-[80%] rounded-t-3xl bg-card"
          style={{ paddingBottom: insets.bottom }}
        >
          {renderSheetContent()}
        </View>
      </View>
    </Modal>
  );
}
