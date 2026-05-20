/* eslint-disable max-lines -- Composer state, keyboard behavior, and attachment queue wiring live together until the follow-up screen wiring task can split boundaries cleanly. */
import { useActionSheet } from '@expo/react-native-action-sheet';
import { File } from 'expo-file-system';
import { Paperclip, Send, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type LayoutChangeEvent, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';
import {
  ATTACHMENT_MAX_BYTES,
  type AttachmentBlock,
  type InputContentBlock,
  type KiloChatClient,
  type Message,
  MESSAGE_TEXT_MAX_CHARS,
} from '@kilocode/kilo-chat';
import { type AddFileInput, useAttachmentQueue } from '@kilocode/kilo-chat-hooks';

import { useTextHeight } from '@/components/agents/use-text-height';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { resolveMessageInputAppStateTransition } from './message-input-app-state';
import {
  MESSAGE_INPUT_FONT_SIZE,
  MESSAGE_INPUT_HORIZONTAL_PADDING,
  MESSAGE_INPUT_LINE_HEIGHT,
  MESSAGE_INPUT_MAX_HEIGHT,
  MESSAGE_INPUT_MIN_HEIGHT,
  MESSAGE_INPUT_VERTICAL_INSET,
  messageInputKeyboardProps,
  messageInputTextStyle,
  resolveMessageInputBottomPadding,
  resolveMessageInputShouldScroll,
} from './message-input-layout';
import {
  applyMessageInputTextChange,
  canSubmitMessageInputContent,
  isMessageInputOverLimit,
  type MessageInputSubmitControls,
  shouldShowMessageInputCounter,
  submitMessageInputDraft,
} from './message-input-state';
import { MessageAttachmentPreviewStrip } from './message-attachment-preview-strip';
import {
  buildAttachmentLimitToast,
  buildAttachmentSizeRejectionToast,
  getAttachmentActionSheetConfig,
  MESSAGE_ATTACHMENT_MAX_COUNT,
} from './message-attachment-state';
import { pickCameraImage, pickFiles, pickLibraryImages } from './message-attachment-picker';
import { mobilePerformUpload } from './mobile-perform-upload';
import { getReplyPreviewText } from './message-presentation';
import { TypingIndicator } from './typing-indicator';

type MessageInputTextOnSend = (
  text: string,
  inReplyToMessageId?: string,
  controls?: MessageInputSubmitControls
) => void;

type MessageInputContentBlocksOnSend = (
  content: InputContentBlock[],
  inReplyToMessageId?: string,
  controls?: MessageInputSubmitControls
) => void;

type AttachmentEnabledProps = {
  client: KiloChatClient;
  conversationId: string;
  hasAttachmentsCapability: boolean;
  onSend: MessageInputContentBlocksOnSend;
};

type AttachmentUnavailableProps = {
  client?: never;
  conversationId?: never;
  hasAttachmentsCapability?: false;
  onSend: MessageInputTextOnSend;
};

type CommonProps = {
  onTyping?: () => void;
  disabled?: boolean;
  submitDisabled?: boolean;
  initialText?: string;
  isEditing?: boolean;
  onCancelEdit?: () => void;
  replyingTo?: Message | null;
  onCancelReply?: () => void;
  disabledReason?: string | null;
  clearOnSubmit?: boolean;
  botName?: string | null;
  typingMembers?: Map<string, number>;
};

type Props = CommonProps & (AttachmentEnabledProps | AttachmentUnavailableProps);

type ComposerAttachmentQueue = ReturnType<typeof useAttachmentQueue> & {
  getLocalUri: (tempId: string) => string | null;
  openPicker: () => void;
  removeFile: (tempId: string) => void;
  clearSubmittedFiles: (tempIds: string[]) => void;
};

const MESSAGE_INPUT_FOCUS_RESTORE_DELAY_MS = 100;
const EMPTY_READY_ATTACHMENT_BLOCKS: readonly AttachmentBlock[] = [];

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

export function MessageInput(props: Props) {
  if (hasAttachmentQueueProps(props)) {
    const { client, conversationId, hasAttachmentsCapability } = props;
    const { onSend, ...contentProps } = props;
    return (
      <MessageInputWithAttachmentQueue
        {...contentProps}
        client={client}
        conversationId={conversationId}
        hasAttachmentsCapability={hasAttachmentsCapability}
        onSendContentBlocks={onSend}
      />
    );
  }

  const { onSend, ...textProps } = props;
  return (
    <MessageInputContent
      {...textProps}
      hasAttachmentsCapability={false}
      attachmentQueue={null}
      onSendText={onSend}
    />
  );
}

function hasAttachmentQueueProps(props: Props): props is CommonProps & AttachmentEnabledProps {
  return props.client !== undefined;
}

function MessageInputWithAttachmentQueue({
  client,
  conversationId,
  onSendContentBlocks,
  ...props
}: CommonProps &
  Omit<AttachmentEnabledProps, 'onSend'> & {
    onSendContentBlocks: MessageInputContentBlocksOnSend;
  }) {
  const localUrisRef = useRef<Map<string, string>>(new Map());

  const onSizeRejected = useCallback((input: AddFileInput) => {
    toast.error(buildAttachmentSizeRejectionToast(input.filename));
  }, []);

  const queue = useAttachmentQueue(client, conversationId, {
    performUpload: mobilePerformUpload,
    maxBytes: ATTACHMENT_MAX_BYTES,
    onSizeRejected,
  });
  const { showActionSheetWithOptions } = useActionSheet();
  const { bottom } = useSafeAreaInsets();

  const addFiles = useCallback(
    (inputs: AddFileInput[]) => {
      const capacity = Math.max(MESSAGE_ATTACHMENT_MAX_COUNT - queue.rows.length, 0);
      const accepted = inputs.slice(0, capacity);

      if (inputs.length > accepted.length) {
        toast.error(buildAttachmentLimitToast());
      }

      for (const input of accepted) {
        const tempId = queue.addFile(input);
        const localUri = localUriFromInput(input);
        if (tempId && localUri) {
          localUrisRef.current.set(tempId, localUri);
        }
      }
    },
    [queue]
  );

  const pickFromSource = useCallback(
    async (source: 'camera' | 'library' | 'files') => {
      try {
        const inputs = await pickAttachmentsFromSource(source);
        addFiles(inputs);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to attach file');
      }
    },
    [addFiles]
  );

  const openPicker = useCallback(() => {
    const actionSheet = getAttachmentActionSheetConfig();
    showActionSheetWithOptions(
      {
        ...actionSheet,
        options: [...actionSheet.options],
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        if (index === 0) {
          void pickFromSource('camera');
        } else if (index === 1) {
          void pickFromSource('library');
        } else if (index === 2) {
          void pickFromSource('files');
        }
      }
    );
  }, [bottom, pickFromSource, showActionSheetWithOptions]);

  const attachmentQueue: ComposerAttachmentQueue = {
    ...queue,
    getLocalUri: tempId => localUrisRef.current.get(tempId) ?? null,
    openPicker,
    removeFile: tempId => {
      queue.removeFile(tempId);
      localUrisRef.current.delete(tempId);
    },
    clearSubmittedFiles: tempIds => {
      queue.clearFiles(tempIds);
      for (const tempId of tempIds) {
        localUrisRef.current.delete(tempId);
      }
    },
  };

  return (
    <MessageInputContent
      {...props}
      attachmentQueue={attachmentQueue}
      onSendContentBlocks={onSendContentBlocks}
    />
  );
}

function localUriFromInput(input: AddFileInput): string | null {
  return input.blob instanceof File ? input.blob.uri : null;
}

async function pickAttachmentsFromSource(source: 'camera' | 'library' | 'files') {
  if (source === 'camera') {
    const inputs = await pickCameraImage();
    return inputs;
  }
  if (source === 'library') {
    const inputs = await pickLibraryImages();
    return inputs;
  }
  const inputs = await pickFiles();
  return inputs;
}

function MessageInputContent({
  onSendText,
  onSendContentBlocks,
  onTyping,
  disabled,
  submitDisabled,
  initialText = '',
  isEditing,
  onCancelEdit,
  replyingTo,
  onCancelReply,
  disabledReason,
  clearOnSubmit,
  botName,
  typingMembers = new Map(),
  hasAttachmentsCapability,
  attachmentQueue,
}: CommonProps & {
  hasAttachmentsCapability: boolean;
  attachmentQueue: ComposerAttachmentQueue | null;
  onSendText?: MessageInputTextOnSend;
  onSendContentBlocks?: MessageInputContentBlocksOnSend;
}) {
  const colors = useThemeColors();
  const valueRef = useRef(initialText);
  const [canSend, setCanSend] = useState(initialText.trim().length > 0);
  const [draftLength, setDraftLength] = useState(initialText.length);
  const [inputWidth, setInputWidth] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const inputFocusedRef = useRef(false);
  const restoreFocusOnActiveRef = useRef(false);
  const restoreFocusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentReplyingToRef = useRef<string | undefined>(replyingTo?.id);
  currentReplyingToRef.current = replyingTo?.id;
  const readyAttachmentBlocks = attachmentQueue?.readyBlocks ?? EMPTY_READY_ATTACHMENT_BLOCKS;
  const hasUploadingAttachment = attachmentQueue?.isUploading ?? false;
  const hasFailedAttachment = attachmentQueue?.hasFailed ?? false;
  const overLimit = isMessageInputOverLimit(valueRef.current);
  const showCounter = shouldShowMessageInputCounter(valueRef.current);
  const sendDisabled =
    submitDisabled === true || resolveSendDisabled({ canSend, disabled, overLimit });
  const controlsDisabled = disabled === true || submitDisabled === true;
  const showAttachmentButton =
    attachmentQueue !== null && hasAttachmentsCapability && isEditing !== true && disabled !== true;
  const inputMeasure = useTextHeight({
    minHeight: MESSAGE_INPUT_MIN_HEIGHT,
    maxHeight: MESSAGE_INPUT_MAX_HEIGHT,
    verticalPadding: MESSAGE_INPUT_VERTICAL_INSET,
    textContentWidth: inputWidth - MESSAGE_INPUT_HORIZONTAL_PADDING,
    fontSize: MESSAGE_INPUT_FONT_SIZE,
    lineHeight: MESSAGE_INPUT_LINE_HEIGHT,
    initialText,
  });

  useEffect(() => {
    const clearRestoreFocusTimeout = () => {
      if (restoreFocusTimeoutRef.current !== null) {
        clearTimeout(restoreFocusTimeoutRef.current);
        restoreFocusTimeoutRef.current = null;
      }
    };

    const subscription = AppState.addEventListener('change', nextAppState => {
      const transition = resolveMessageInputAppStateTransition({
        nextAppState,
        restoreFocusOnActive: restoreFocusOnActiveRef.current,
        wasFocused: inputFocusedRef.current,
      });
      restoreFocusOnActiveRef.current = transition.restoreFocusOnActive;

      if (transition.shouldBlur) {
        clearRestoreFocusTimeout();
        inputRef.current?.blur();
      }

      if (transition.shouldFocus && disabled !== true && submitDisabled !== true) {
        clearRestoreFocusTimeout();
        restoreFocusTimeoutRef.current = setTimeout(() => {
          restoreFocusTimeoutRef.current = null;
          inputRef.current?.focus();
        }, MESSAGE_INPUT_FOCUS_RESTORE_DELAY_MS);
      }
    });

    return () => {
      subscription.remove();
      clearRestoreFocusTimeout();
    };
  }, [disabled, submitDisabled]);

  useEffect(() => {
    setCanSend(
      canSubmitMessageInputContent({
        text: valueRef.current,
        readyAttachmentBlocks,
        hasUploadingAttachment,
        hasFailedAttachment,
      })
    );
  }, [hasFailedAttachment, hasUploadingAttachment, readyAttachmentBlocks]);

  const submit = () => {
    if (disabled || submitDisabled) {
      return;
    }
    const submittedAttachmentTempIds =
      attachmentQueue?.rows.filter(row => row.status === 'ready').map(row => row.tempId) ?? [];
    submitMessageInputDraft({
      valueRef,
      replyingToMessageId: replyingTo?.id,
      onSend: (text, inReplyToMessageId, controls) => {
        onSendText?.(text, inReplyToMessageId, controls);
      },
      onSendContentBlocks:
        attachmentQueue === null
          ? undefined
          : (content, inReplyToMessageId, controls) => {
              onSendContentBlocks?.(content, inReplyToMessageId, {
                clearDraft: () => {
                  const cleared = controls?.clearDraft() ?? false;
                  if (cleared) {
                    attachmentQueue.clearSubmittedFiles(submittedAttachmentTempIds);
                  }
                  return cleared;
                },
              });
            },
      clearInput: () => {
        inputRef.current?.clear();
        setDraftLength(0);
        inputMeasure.reset();
      },
      setCanSend,
      getCurrentReplyingToMessageId: () => currentReplyingToRef.current,
      clearOnSubmit,
      readyAttachmentBlocks,
      hasUploadingAttachment,
      hasFailedAttachment,
    });
  };

  function handleInputLayout(event: LayoutChangeEvent) {
    const nextWidth = Math.max(Math.round(event.nativeEvent.layout.width), 0);
    setInputWidth(current => (current === nextWidth ? current : nextWidth));
  }

  const handleOpenAttachmentPicker = () => {
    attachmentQueue?.openPicker();
  };

  const handleRemoveAttachment = (tempId: string) => {
    attachmentQueue?.removeFile(tempId);
  };

  const handleRetryAttachment = (tempId: string) => {
    attachmentQueue?.retryFile(tempId);
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
      {attachmentQueue && (
        <MessageAttachmentPreviewStrip
          rows={attachmentQueue.rows}
          getLocalUri={attachmentQueue.getLocalUri}
          onRemove={handleRemoveAttachment}
          onRetry={handleRetryAttachment}
        />
      )}
      <View className="gap-1">
        {inputMeasure.measureElement}
        <View className="flex-row items-center gap-2">
          {showAttachmentButton ? (
            <Pressable
              onPress={handleOpenAttachmentPicker}
              disabled={controlsDisabled}
              className={cn(
                'h-10 w-10 items-center justify-center rounded-md bg-secondary active:opacity-70',
                controlsDisabled && 'opacity-50'
              )}
              accessibilityLabel="Attach file"
            >
              <Paperclip size={18} color={colors.foreground} />
            </Pressable>
          ) : null}
          <View className="min-w-0 flex-1" onLayout={handleInputLayout}>
            <TextInput
              ref={inputRef}
              className={cn(
                'rounded-md border bg-card px-3 text-foreground',
                overLimit ? 'border-destructive' : 'border-input'
              )}
              style={[messageInputTextStyle, { height: inputMeasure.height }]}
              placeholder="Message"
              placeholderTextColor={colors.mutedForeground}
              defaultValue={initialText}
              multiline
              scrollEnabled={resolveMessageInputShouldScroll(inputMeasure.height)}
              editable={!disabled}
              onChangeText={t => {
                setDraftLength(t.length);
                inputMeasure.setText(t);
                applyMessageInputTextChange({
                  text: t,
                  valueRef,
                  setCanSend,
                  onTyping,
                  readyAttachmentBlocks,
                  hasUploadingAttachment,
                  hasFailedAttachment,
                });
              }}
              onFocus={() => {
                inputFocusedRef.current = true;
              }}
              onBlur={() => {
                inputFocusedRef.current = false;
              }}
              onSubmitEditing={submit}
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
