import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { withUiDeadline } from '@/lib/ui-deadline';
import { cn } from '@/lib/utils';

const SAVE_UI_DEADLINE_MS = 15_000;

type RenameModalProps = {
  title: string;
  placeholder: string;
  initialValue: string;
  onSave: (name: string) => Promise<unknown>;
  onClose: () => void;
  maxLength?: number;
};

// Mount this component only while the modal should be open (e.g. `{visible && <RenameModal ... />}`)
// so each open gets fresh state: current initialValue, a reset canSave, and a re-armed Android autofocus.
export function RenameModal({
  title,
  placeholder,
  initialValue,
  onSave,
  onClose,
  maxLength = 50,
}: Readonly<RenameModalProps>) {
  const colors = useThemeColors();
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
      setErrorText(error instanceof Error ? error.message : 'Something went wrong');
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
          <TextInput
            ref={inputRef}
            accessible
            accessibilityLabel={placeholder}
            className={cn(
              'rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground',
              pending && 'opacity-50'
            )}
            placeholder={placeholder}
            placeholderTextColor={colors.mutedForeground}
            defaultValue={initialValue}
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
              <Text>Cancel</Text>
            </Button>
            <Button
              onPress={() => {
                void handleSave();
              }}
              disabled={!canSave || saveInFlight}
              loading={pending}
            >
              <Text className="text-primary-foreground">Save</Text>
            </Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
