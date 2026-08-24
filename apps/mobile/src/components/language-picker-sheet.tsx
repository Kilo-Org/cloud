import { Portal } from '@rn-primitives/portal';
import { reloadAppAsync } from 'expo';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  BackHandler,
  I18nManager,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { PickerSheet } from '@/components/picker-sheet';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { applyLanguagePreference } from '@/i18n/apply-language';
import { LANGUAGE_ENDONYMS, SUPPORTED_LANGUAGES } from '@/i18n/languages';
import { resolveDeviceLanguage } from '@/i18n/resolve-language';
import { isRtlLanguage } from '@/i18n/rtl';
import { type LanguageReturnTarget } from '@/i18n/return-target';
import {
  getLanguagePreference,
  type LanguagePreference,
} from '@/lib/hooks/use-language-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

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

  useEffect(() => {
    if (visible) {
      setSelected(getLanguagePreference());
      setBusy(false);
      setRestarting(false);
      setReloadFailed(false);
    }
  }, [visible]);

  // profile-screen passes onClose as a new inline arrow on every render, so a
  // dep on it re-registers the BackHandler listener on every parent render and
  // can leave the event unconsumed on a real device. Register once while the
  // picker is open and read the latest values from refs.
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const reloadFailedRef = useRef(reloadFailed);
  onCloseRef.current = onClose;
  busyRef.current = busy;
  reloadFailedRef.current = reloadFailed;

  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!busyRef.current && !reloadFailedRef.current) {
        onCloseRef.current();
      }
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [visible]);

  if (!visible) {
    return null;
  }

  const deviceEndonym = LANGUAGE_ENDONYMS[resolveDeviceLanguage()];
  const isRtl = i18n.dir() === 'rtl';

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
      default: {
        // Unknown outcome: leave the sheet open.
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
        <ScrollView className="max-h-[60vh]">
          <ChoiceRow
            selected={selected === 'device'}
            disabled={busy}
            onPress={() => {
              setSelected('device');
            }}
          >
            <View className={`flex-1 ${isRtl ? 'pl-3' : 'pr-3'}`}>
              <Text className="text-sm font-medium">{t('common.device')}</Text>
              <Text variant="muted" className="mt-0.5 text-xs">
                {deviceEndonym}
              </Text>
            </View>
          </ChoiceRow>
          {SUPPORTED_LANGUAGES.map(tag => (
            <ChoiceRow
              key={tag}
              selected={selected === tag}
              disabled={busy}
              onPress={() => {
                setSelected(tag);
              }}
            >
              <View className={`flex-1 ${isRtl ? 'pl-3' : 'pr-3'}`}>
                <Text className="text-sm font-medium">{LANGUAGE_ENDONYMS[tag]}</Text>
              </View>
            </ChoiceRow>
          ))}
        </ScrollView>
      </PickerSheet>
    );
  };

  return (
    <Portal name="language-picker">
      <Animated.View
        entering={FadeIn.duration(150)}
        exiting={FadeOut.duration(150)}
        className="absolute inset-0 justify-end bg-black/40"
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
        <Animated.View
          entering={SlideInDown.duration(220)}
          exiting={SlideOutDown.duration(180)}
          accessibilityViewIsModal
          className="max-h-[80%] rounded-t-3xl bg-card"
          style={{ paddingBottom: insets.bottom }}
        >
          {renderSheetContent()}
        </Animated.View>
      </Animated.View>
    </Portal>
  );
}
