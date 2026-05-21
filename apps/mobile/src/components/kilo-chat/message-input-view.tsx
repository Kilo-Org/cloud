import { Paperclip, Send, X } from 'lucide-react-native';
import { type ReactNode, type RefObject } from 'react';
import { type LayoutChangeEvent, Pressable, TextInput, View } from 'react-native';
import { type Message, MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';
import { type QueuedAttachment } from '@kilocode/kilo-chat-hooks';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { MessageAttachmentPreviewStrip } from './message-attachment-preview-strip';
import { messageInputKeyboardProps, messageInputTextStyle } from './message-input-layout';
import { type ComposerAttachmentQueue } from './message-input-types';
import { getReplyPreviewText } from './message-presentation';
import { TypingIndicator } from './typing-indicator';

type Props = {
  attachmentQueue: ComposerAttachmentQueue | null;
  botName?: string | null;
  controlsDisabled: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  draftLength: number;
  editableAttachmentRows: QueuedAttachment[];
  inputHeight: number;
  inputMeasureElement: ReactNode;
  inputRef: RefObject<TextInput | null>;
  initialText: string;
  onCancelEdit?: () => void;
  onCancelReply?: () => void;
  onChangeText: (text: string) => void;
  onInputBlur: () => void;
  onInputFocus: () => void;
  onInputLayout: (event: LayoutChangeEvent) => void;
  onOpenAttachmentPicker: () => void;
  onRemoveAttachment: (tempId: string) => void;
  onRemoveEditableAttachment: (attachmentId: string) => void;
  onRetryAttachment: (tempId: string) => void;
  onSubmit: () => void;
  overLimit: boolean;
  replyingTo?: Message | null;
  sendDisabled: boolean;
  showAttachmentButton: boolean;
  showCounter: boolean;
  shouldScroll: boolean;
  typingMembers: Map<string, number>;
};

export function MessageInputView({
  attachmentQueue,
  botName,
  controlsDisabled,
  disabled,
  disabledReason,
  draftLength,
  editableAttachmentRows,
  inputHeight,
  inputMeasureElement,
  inputRef,
  initialText,
  onCancelEdit,
  onCancelReply,
  onChangeText,
  onInputBlur,
  onInputFocus,
  onInputLayout,
  onOpenAttachmentPicker,
  onRemoveAttachment,
  onRemoveEditableAttachment,
  onRetryAttachment,
  onSubmit,
  overLimit,
  replyingTo,
  sendDisabled,
  showAttachmentButton,
  showCounter,
  shouldScroll,
  typingMembers,
}: Props) {
  const colors = useThemeColors();

  return (
    <>
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
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
            accessibilityState={{ disabled: controlsDisabled }}
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
      {attachmentQueue && (
        <MessageAttachmentPreviewStrip
          rows={attachmentQueue.rows}
          getLocalUri={attachmentQueue.getLocalUri}
          onRemove={onRemoveAttachment}
          onRetry={onRetryAttachment}
        />
      )}
      {editableAttachmentRows.length > 0 ? (
        <MessageAttachmentPreviewStrip
          rows={editableAttachmentRows}
          getLocalUri={() => null}
          onRemove={onRemoveEditableAttachment}
        />
      ) : null}
      <View className="gap-1">
        {inputMeasureElement}
        <View className="flex-row items-center gap-2">
          {showAttachmentButton ? (
            <Pressable
              onPress={onOpenAttachmentPicker}
              disabled={controlsDisabled}
              className={cn(
                'h-10 w-10 items-center justify-center rounded-md bg-secondary active:opacity-70',
                controlsDisabled && 'opacity-50'
              )}
              accessibilityRole="button"
              accessibilityLabel="Attach file"
              accessibilityState={{ disabled: controlsDisabled }}
            >
              <Paperclip size={18} color={colors.foreground} />
            </Pressable>
          ) : null}
          <View className="min-w-0 flex-1" onLayout={onInputLayout}>
            <TextInput
              ref={inputRef}
              className={cn(
                'rounded-md border bg-card px-3 text-foreground',
                overLimit ? 'border-destructive' : 'border-input'
              )}
              style={[messageInputTextStyle, { height: inputHeight }]}
              placeholder="Message"
              placeholderTextColor={colors.mutedForeground}
              defaultValue={initialText}
              multiline
              scrollEnabled={shouldScroll}
              editable={!disabled}
              onChangeText={onChangeText}
              onFocus={onInputFocus}
              onBlur={onInputBlur}
              onSubmitEditing={onSubmit}
              {...messageInputKeyboardProps}
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
              accessibilityRole="button"
              accessibilityLabel="Cancel edit"
              accessibilityState={{ disabled: controlsDisabled }}
            >
              <X size={18} color={colors.foreground} />
            </Pressable>
          )}
          <Pressable
            onPress={onSubmit}
            disabled={sendDisabled}
            className={cn(
              'h-10 w-10 items-center justify-center rounded-md bg-primary',
              sendDisabled && 'opacity-50'
            )}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: sendDisabled }}
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
    </>
  );
}
