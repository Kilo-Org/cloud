import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type Props = {
  visible: boolean;
  initialText: string;
  onCancel: () => void;
  onSave: (text: string) => void;
};

export function EditMessageModal({ visible, initialText, onCancel, onSave }: Props) {
  const colors = useThemeColors();
  const valueRef = useRef(initialText);
  const [canSave, setCanSave] = useState(initialText.trim().length > 0);

  useEffect(() => {
    if (visible) {
      valueRef.current = initialText;
      setCanSave(initialText.trim().length > 0);
    }
  }, [initialText, visible]);

  const submit = () => {
    const text = valueRef.current.trim();
    if (!text) {
      return;
    }
    onSave(text);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-black/40 px-4 py-6">
        <View className="gap-3 rounded-lg bg-background p-4">
          <Text className="text-base font-semibold text-foreground">Edit message</Text>
          <TextInput
            key={initialText}
            className="min-h-24 rounded-md border border-input bg-card px-3 py-2 leading-5 text-foreground"
            defaultValue={initialText}
            multiline
            autoFocus
            placeholderTextColor={colors.mutedForeground}
            onChangeText={text => {
              valueRef.current = text;
              setCanSave(text.trim().length > 0);
            }}
          />
          <View className="flex-row justify-end gap-2">
            <Pressable className="h-10 justify-center rounded-md px-3" onPress={onCancel}>
              <Text className="text-sm font-medium text-muted-foreground">Cancel</Text>
            </Pressable>
            <Button disabled={!canSave} onPress={submit}>
              <Text>Save</Text>
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}
