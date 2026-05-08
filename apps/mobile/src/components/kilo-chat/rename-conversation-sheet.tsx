import { CONVERSATION_TITLE_MAX_CHARS } from '@kilocode/kilo-chat';
import { useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type RenameConversationSheetProps = {
  initialTitle: string;
  isSaving: boolean;
  onCancel: () => void;
  onSave: (title: string) => void;
};

function canSaveTitle(text: string, initialTitle: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= CONVERSATION_TITLE_MAX_CHARS &&
    trimmed !== initialTitle.trim()
  );
}

export function RenameConversationSheet({
  initialTitle,
  isSaving,
  onCancel,
  onSave,
}: Readonly<RenameConversationSheetProps>) {
  const colors = useThemeColors();
  const titleRef = useRef(initialTitle);
  const [canSave, setCanSave] = useState(false);

  function handleTextChange(text: string) {
    titleRef.current = text;
    setCanSave(canSaveTitle(text, initialTitle));
  }

  function handleSave() {
    const title = titleRef.current.trim();
    if (canSaveTitle(title, initialTitle)) {
      onSave(title);
    }
  }

  return (
    <View className="flex-1 bg-background px-5 pt-6">
      <View className="gap-5">
        <View className="gap-1">
          <Text className="text-lg font-semibold text-foreground">Rename conversation</Text>
          <Text variant="muted">Set a short name for this thread.</Text>
        </View>
        <TextInput
          autoFocus
          defaultValue={initialTitle}
          maxLength={CONVERSATION_TITLE_MAX_CHARS}
          onChangeText={handleTextChange}
          onSubmitEditing={handleSave}
          returnKeyType="done"
          selectionColor={colors.primary}
          placeholder="Conversation title"
          placeholderTextColor={colors.mutedForeground}
          className="rounded-xl border border-border bg-card px-4 py-3 text-base leading-5 text-foreground"
        />
        <View className="flex-row justify-end gap-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel rename"
            hitSlop={8}
            onPress={onCancel}
            className="h-10 justify-center px-2 active:opacity-70"
          >
            <Text className="text-sm text-muted-foreground">Cancel</Text>
          </Pressable>
          <Button
            disabled={!canSave || isSaving}
            onPress={handleSave}
            accessibilityLabel="Save conversation name"
          >
            <Text>{isSaving ? 'Saving…' : 'Save'}</Text>
          </Button>
        </View>
      </View>
    </View>
  );
}
