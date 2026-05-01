import { Send, X } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { type Message } from '@kilocode/kilo-chat';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { applyMessageInputTextChange, submitMessageInputDraft } from './message-input-state';
import { getReplyPreviewText } from './message-presentation';

type Props = {
  onSend: (text: string, inReplyToMessageId?: string) => void;
  onTyping?: () => void;
  disabled?: boolean;
  initialText?: string;
  onCancelEdit?: () => void;
  replyingTo?: Message | null;
  onCancelReply?: () => void;
};

export function MessageInput({
  onSend,
  onTyping,
  disabled,
  initialText = '',
  onCancelEdit,
  replyingTo,
  onCancelReply,
}: Props) {
  const colors = useThemeColors();
  const valueRef = useRef(initialText);
  const [canSend, setCanSend] = useState(initialText.trim().length > 0);
  const inputRef = useRef<TextInput>(null);

  const submit = () => {
    submitMessageInputDraft({
      valueRef,
      replyingToMessageId: replyingTo?.id,
      onSend,
      clearInput: () => inputRef.current?.clear(),
      setCanSend,
    });
  };

  return (
    <View className="border-t border-border bg-background px-4 py-2">
      {replyingTo && (
        <View className="mb-2 flex-row items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
          <View className="min-w-0 flex-1">
            <Text className="text-xs font-medium text-muted-foreground">Replying to</Text>
            <Text numberOfLines={1} className="text-sm text-foreground">
              {getReplyPreviewText(replyingTo)}
            </Text>
          </View>
          <Pressable
            onPress={onCancelReply}
            disabled={disabled}
            className={cn(
              'h-8 w-8 items-center justify-center rounded-md bg-secondary',
              disabled && 'opacity-50'
            )}
          >
            <X size={16} color={colors.foreground} />
          </Pressable>
        </View>
      )}
      <View className="flex-row items-end gap-2">
        <TextInput
          ref={inputRef}
          className="flex-1 rounded-md border border-input bg-card px-3 py-2 leading-5 text-foreground"
          placeholder="Message"
          placeholderTextColor={colors.mutedForeground}
          defaultValue={initialText}
          multiline
          onChangeText={t => {
            applyMessageInputTextChange({
              text: t,
              valueRef,
              setCanSend,
              onTyping,
            });
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
    </View>
  );
}
