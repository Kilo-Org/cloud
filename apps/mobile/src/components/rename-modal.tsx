import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Platform, Pressable, type TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { withUiDeadline } from '@/lib/ui-deadline';
import { cn } from '@/lib/utils';

const SAVE_UI_DEADLINE_MS = 15_000;

type RenameModalProps<TSaveResult> = {
  title: string;
  placeholder: string;
  initialValue: string;
  onSave: (name: string) => Promise<TSaveResult>;
  onClose: () => void;
  maxLength?: number;
  /**
   * Render the field as a wrapping multi-line box. Goal text is prose that can
   * hold a long unbroken line: a single-line field scrolls horizontally and
   * clips the start of the value, so that caller opts in here. Rename dialogs
   * keep the single-line field.
   */
  multiline?: boolean;
};

// Mount this component only while the modal should be open (e.g. `{visible && <RenameModal ... />}`)
// so each open gets fresh state: current initialValue, a reset canSave, and a re-armed Android autofocus.
export function RenameModal<TSaveResult>({
  title,
  placeholder,
  initialValue,
  onSave,
  onClose,
  maxLength = 50,
  multiline = false,
}: Readonly<RenameModalProps<TSaveResult>>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const nameRef = useRef(initialValue);
  const inputRef = useRef<TextInput>(null);
  const [canSave, setCanSave] = useState(false);
  const [pending, setPending] = useState(false);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // autoFocus doesn't reliably raise the keyboard inside Modal on Android
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  const handleClose = () => {
    if (pending) {
      return;
    }
    onClose();
  };

  const handleSave = async () => {
    const trimmed = nameRef.current.trim();
    setPending(true);
    setSaveInFlight(true);
    setErrorText(null);
    const operation = onSave(trimmed);
    void (async () => {
      try {
        await operation;
      } catch {
        // The main save path below owns user-visible error feedback.
      } finally {
        setSaveInFlight(false);
      }
    })();
    try {
      await withUiDeadline(operation, SAVE_UI_DEADLINE_MS);
      onClose();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : t('common.somethingWentWrong'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={handleClose}>
      <Pressable
        accessible={false}
        className="flex-1 justify-start px-6 pt-[25%]"
        onPress={handleClose}
      >
        <View className="absolute inset-0 bg-black opacity-50" />
        <Pressable
          accessible={false}
          className="rounded-xl bg-card p-5 gap-4"
          accessibilityViewIsModal
          onPress={e => {
            e.stopPropagation();
          }}
        >
          <Text className="text-base font-semibold">{title}</Text>
          <Input
            ref={inputRef}
            accessible
            accessibilityLabel={placeholder}
            // Single-line: leading-[normal] (not leading-5) so no lineHeight reaches
            // the style: a lineHeight above the font's natural one makes iOS draw the
            // placeholder lower than the typed text and clip its bottom.
            // Multi-line: an explicit leading-5 plus bounded min/max heights, so the
            // value soft-wraps into the field and scrolls vertically past the cap.
            className={cn(
              'rounded-md border border-input bg-background px-3 text-sm text-foreground',
              multiline ? 'py-2.5 max-h-40 min-h-24 leading-5' : 'leading-[normal]',
              pending && 'opacity-50'
            )}
            placeholder={placeholder}
            placeholderTextColor={colors.mutedForeground}
            defaultValue={initialValue}
            multiline={multiline}
            textAlignVertical={multiline ? 'top' : undefined}
            onChangeText={val => {
              nameRef.current = val;
              const trimmed = val.trim();
              setCanSave(trimmed.length > 0 && trimmed !== initialValue);
            }}
            autoFocus={Platform.OS !== 'android'}
            maxLength={maxLength}
            editable={!pending}
            accessibilityState={{ disabled: pending }}
          />
          {errorText ? <Text className="text-sm text-destructive">{errorText}</Text> : null}
          <View className="flex-row justify-end gap-3">
            <Button variant="outline" onPress={handleClose} disabled={pending}>
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              onPress={() => {
                void handleSave();
              }}
              disabled={!canSave || saveInFlight}
              loading={pending}
            >
              <Text className="text-primary-foreground">{t('common.save')}</Text>
            </Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
