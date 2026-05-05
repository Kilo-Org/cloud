import { Send, X } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { type Message, MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { messageInputTextStyle, resolveMessageInputBottomPadding } from './message-input-layout';
import {
  applyMessageInputTextChange,
  isMessageInputOverLimit,
  type MessageInputSubmitControls,
  shouldShowMessageInputCounter,
  submitMessageInputDraft,
} from './message-input-state';
import { getReplyPreviewText } from './message-presentation';
import { TypingIndicator } from './typing-indicator';

type Props = {
  onSend: (
    text: string,
    inReplyToMessageId?: string,
    controls?: MessageInputSubmitControls
  ) => void;
  onTyping?: () => void;
  disabled?: boolean;
  submitDisabled?: boolean;
  initialText?: string;
  onCancelEdit?: () => void;
  replyingTo?: Message | null;
  onCancelReply?: () => void;
  disabledReason?: string | null;
  clearOnSubmit?: boolean;
  botName?: string | null;
  typingMembers?: Map<string, number>;
};

function resolveSendDisabled({
  canSend,
  disabled,
  overLimit,
}: {
  canSend: boolean;
  disabled?: boolean;
  overLimit: boolean;
}): boolean {
  if (!canSend) {
    return true;
  }
  if (disabled === true) {
    return true;
  }
  return overLimit;
}

export function MessageInput({
  onSend,
  onTyping,
  disabled,
  submitDisabled,
  initialText = '',
  onCancelEdit,
  replyingTo,
  onCancelReply,
  disabledReason,
  clearOnSubmit,
  botName,
  typingMembers = new Map(),
}: Props) {
  const colors = useThemeColors();
  const valueRef = useRef(initialText);
  const [canSend, setCanSend] = useState(initialText.trim().length > 0);
  const [draftLength, setDraftLength] = useState(initialText.length);
  const inputRef = useRef<TextInput>(null);
  const currentReplyingToRef = useRef<string | undefined>(replyingTo?.id);
  currentReplyingToRef.current = replyingTo?.id;
  const overLimit = isMessageInputOverLimit(valueRef.current);
  const showCounter = shouldShowMessageInputCounter(valueRef.current);
  const sendDisabled =
    submitDisabled === true || resolveSendDisabled({ canSend, disabled, overLimit });
  const controlsDisabled = disabled === true || submitDisabled === true;

  const submit = () => {
    if (disabled || submitDisabled) {
      return;
    }
    submitMessageInputDraft({
      valueRef,
      replyingToMessageId: replyingTo?.id,
      onSend,
      clearInput: () => {
        inputRef.current?.clear();
        setDraftLength(0);
      },
      setCanSend,
      getCurrentReplyingToMessageId: () => currentReplyingToRef.current,
      clearOnSubmit,
    });
  };

  return (
    <View
      style={{
        paddingBottom: resolveMessageInputBottomPadding(),
      }}
      className="border-t border-border bg-background px-4 pt-2"
    >
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
            disabled={controlsDisabled}
            className={cn(
              'h-8 w-8 items-center justify-center rounded-md bg-secondary',
              controlsDisabled && 'opacity-50'
            )}
          >
            <X size={16} color={colors.foreground} />
          </Pressable>
        </View>
      )}
      {disabledReason && (
        <View className="mb-2 rounded-md bg-secondary px-3 py-2">
          <Text className="text-xs text-muted-foreground">{disabledReason}</Text>
        </View>
      )}
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <View className="min-w-0 flex-1">
            <TextInput
              ref={inputRef}
              className={cn(
                'rounded-md border bg-card px-3 text-foreground',
                overLimit ? 'border-destructive' : 'border-input'
              )}
              style={messageInputTextStyle}
              placeholder="Message"
              placeholderTextColor={colors.mutedForeground}
              defaultValue={initialText}
              multiline
              scrollEnabled={draftLength > 160}
              editable={!disabled}
              onChangeText={t => {
                setDraftLength(t.length);
                applyMessageInputTextChange({
                  text: t,
                  valueRef,
                  setCanSend,
                  onTyping,
                });
              }}
              onSubmitEditing={submit}
              returnKeyType="send"
              submitBehavior="submit"
            />
          </View>
          {onCancelEdit && (
            <Pressable
              onPress={onCancelEdit}
              disabled={controlsDisabled}
              className={cn(
                'h-10 w-10 items-center justify-center rounded-md bg-secondary',
                controlsDisabled && 'opacity-50'
              )}
            >
              <X size={18} color={colors.foreground} />
            </Pressable>
          )}
          <Pressable
            onPress={submit}
            disabled={sendDisabled}
            className={cn(
              'h-10 w-10 items-center justify-center rounded-md bg-primary',
              sendDisabled && 'opacity-50'
            )}
          >
            <Send size={18} color={colors.primaryForeground} />
          </Pressable>
        </View>
        {showCounter ? (
          <View className="items-end justify-center">
            <Text className={cn('text-xs text-muted-foreground', overLimit && 'text-destructive')}>
              {draftLength}/{MESSAGE_TEXT_MAX_CHARS}
            </Text>
          </View>
        ) : null}
        <TypingIndicator botName={botName} typingMembers={typingMembers} />
      </View>
    </View>
  );
}
