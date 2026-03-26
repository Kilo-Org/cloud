import { useRef } from 'react';
import { Modal, Pressable, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type RenameInstanceModalProps = {
  defaultName: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
};

export function RenameInstanceModal({
  defaultName,
  onSubmit,
  onClose,
}: Readonly<RenameInstanceModalProps>) {
  const colors = useThemeColors();
  const nameRef = useRef(defaultName);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 justify-start px-6 pt-[25%]" onPress={onClose}>
        <View className="absolute inset-0 bg-black opacity-50" />
        <Pressable
          className="rounded-xl bg-card p-5 gap-4"
          onPress={e => {
            e.stopPropagation();
          }}
        >
          <Text className="text-base font-semibold">Rename Instance</Text>
          <TextInput
            className="rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground"
            placeholder="Enter a new name (max 50 characters)"
            placeholderTextColor={colors.mutedForeground}
            defaultValue={defaultName}
            onChangeText={val => {
              nameRef.current = val;
            }}
            autoFocus
            maxLength={50}
          />
          <View className="flex-row justify-end gap-3">
            <Button variant="outline" onPress={onClose}>
              <Text>Cancel</Text>
            </Button>
            <Button
              onPress={() => {
                const trimmed = nameRef.current.trim();
                if (trimmed) {
                  onSubmit(trimmed);
                }
                onClose();
              }}
            >
              <Text className="text-primary-foreground">Save</Text>
            </Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
