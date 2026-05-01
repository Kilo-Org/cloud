import { Send, X } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { cn } from '@/lib/utils';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type Props = {
  onSend: (text: string) => void;
  disabled?: boolean;
  initialText?: string;
  onCancelEdit?: () => void;
};

export function MessageInput({ onSend, disabled, initialText = '', onCancelEdit }: Props) {
  const colors = useThemeColors();
  const valueRef = useRef(initialText);
  const [canSend, setCanSend] = useState(initialText.trim().length > 0);
  const inputRef = useRef<TextInput>(null);

  const submit = () => {
    const text = valueRef.current.trim();
    if (!text) {
      return;
    }
    onSend(text);
    valueRef.current = '';
    inputRef.current?.clear();
    setCanSend(false);
  };

  return (
    <View className="flex-row items-end gap-2 border-t border-border bg-background px-4 py-2">
      <TextInput
        ref={inputRef}
        className="flex-1 rounded-md border border-input bg-card px-3 py-2 leading-5 text-foreground"
        placeholder="Message"
        placeholderTextColor={colors.mutedForeground}
        defaultValue={initialText}
        multiline
        onChangeText={t => {
          valueRef.current = t;
          setCanSend(t.trim().length > 0);
        }}
        onSubmitEditing={submit}
      />
      {onCancelEdit && (
        <Pressable
          onPress={onCancelEdit}
          disabled={disabled}
          className={cn(
            'h-10 w-10 items-center justify-center rounded-md bg-secondary',
            disabled && 'opacity-50'
          )}
        >
          <X size={18} color={colors.foreground} />
        </Pressable>
      )}
      <Pressable
        onPress={submit}
        disabled={!canSend || disabled}
        className={cn(
          'h-10 w-10 items-center justify-center rounded-md bg-primary',
          (!canSend || disabled) && 'opacity-50'
        )}
      >
        <Send size={18} color={colors.primaryForeground} />
      </Pressable>
    </View>
  );
}
