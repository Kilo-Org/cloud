import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type LayoutChangeEvent, Platform, type TextInput, View } from 'react-native';
import { type AttachmentBlock } from '@kilocode/kilo-chat';
import { type QueuedAttachment } from '@kilocode/kilo-chat-hooks';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTextHeight } from '@/components/agents/use-text-height';
import { resolveMessageInputAppStateTransition } from './message-input-app-state';
import {
  MESSAGE_INPUT_FONT_SIZE,
  MESSAGE_INPUT_HORIZONTAL_PADDING,
  MESSAGE_INPUT_LINE_HEIGHT,
  MESSAGE_INPUT_MAX_HEIGHT,
  MESSAGE_INPUT_MIN_HEIGHT,
  MESSAGE_INPUT_VERTICAL_INSET,
  resolveMessageInputBottomPadding,
  resolveMessageInputShouldScroll,
} from './message-input-layout';
import {
  type CommonProps,
  type ComposerAttachmentQueue,
  type MessageInputContentBlocksOnSend,
  type MessageInputTextOnSend,
} from './message-input-types';
import {
  applyMessageInputTextChange,
  canSubmitMessageInputContent,
  clearSubmittedMessageInputDraft,
  isMessageInputOverLimit,
  shouldShowMessageInputCounter,
  submitMessageInputDraft,
} from './message-input-state';
import { MessageInputView } from './message-input-view';

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

export function MessageInputContent({
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
  editableAttachments = EMPTY_READY_ATTACHMENT_BLOCKS,
  onRemoveEditableAttachment,
  hasAttachmentsCapability,
  attachmentQueue,
}: CommonProps & {
  hasAttachmentsCapability: boolean;
  attachmentQueue: ComposerAttachmentQueue | null;
  onSendText?: MessageInputTextOnSend;
  onSendContentBlocks?: MessageInputContentBlocksOnSend;
}) {
  const { bottom } = useSafeAreaInsets();
  const valueRef = useRef(initialText);
  const [canSend, setCanSend] = useState(() =>
    canSubmitMessageInputContent({ text: initialText, readyAttachmentBlocks: editableAttachments })
  );
  const [draftLength, setDraftLength] = useState(initialText.length);
  const [inputWidth, setInputWidth] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const inputFocusedRef = useRef(false);
  const restoreFocusOnActiveRef = useRef(false);
  const restoreFocusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentReplyingToRef = useRef<string | undefined>(replyingTo?.id);
  currentReplyingToRef.current = replyingTo?.id;
  const queuedReadyAttachmentBlocks = attachmentQueue?.readyBlocks ?? EMPTY_READY_ATTACHMENT_BLOCKS;
  const readyAttachmentBlocks = useMemo(
    () => [...editableAttachments, ...queuedReadyAttachmentBlocks],
    [editableAttachments, queuedReadyAttachmentBlocks]
  );
  const editableAttachmentRows = useMemo(
    () => editableAttachments.map(attachment => editableAttachmentToPreviewRow(attachment)),
    [editableAttachments]
  );
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
                clearDraft: () =>
                  clearSubmittedMessageInputDraft({
                    controls,
                    submittedAttachmentTempIds,
                    clearSubmittedFiles: attachmentQueue.clearSubmittedFiles,
                  }),
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

  const handleRemoveEditableAttachment = (attachmentId: string) => {
    onRemoveEditableAttachment?.(attachmentId);
  };

  const handleChangeText = (text: string) => {
    setDraftLength(text.length);
    inputMeasure.setText(text);
    applyMessageInputTextChange({
      text,
      valueRef,
      setCanSend,
      onTyping,
      readyAttachmentBlocks,
      hasUploadingAttachment,
      hasFailedAttachment,
    });
  };

  return (
    <View
      style={{
        paddingBottom: resolveMessageInputBottomPadding({
          bottomSafeAreaInset: bottom,
          platform: Platform.OS,
        }),
      }}
      className="border-t border-border bg-background px-4 pt-2"
    >
      <MessageInputView
        attachmentQueue={attachmentQueue}
        botName={botName}
        controlsDisabled={controlsDisabled}
        disabled={disabled}
        disabledReason={disabledReason}
        draftLength={draftLength}
        editableAttachmentRows={editableAttachmentRows}
        inputHeight={inputMeasure.height}
        inputMeasureElement={inputMeasure.measureElement}
        inputRef={inputRef}
        initialText={initialText}
        onCancelEdit={onCancelEdit}
        onCancelReply={onCancelReply}
        onChangeText={handleChangeText}
        onInputBlur={() => {
          inputFocusedRef.current = false;
        }}
        onInputFocus={() => {
          inputFocusedRef.current = true;
        }}
        onInputLayout={handleInputLayout}
        onOpenAttachmentPicker={handleOpenAttachmentPicker}
        onRemoveAttachment={handleRemoveAttachment}
        onRemoveEditableAttachment={handleRemoveEditableAttachment}
        onRetryAttachment={handleRetryAttachment}
        onSubmit={submit}
        overLimit={overLimit}
        replyingTo={replyingTo}
        sendDisabled={sendDisabled}
        showAttachmentButton={showAttachmentButton}
        showCounter={showCounter}
        shouldScroll={resolveMessageInputShouldScroll(inputMeasure.height)}
        typingMembers={typingMembers}
      />
    </View>
  );
}

function editableAttachmentToPreviewRow(attachment: AttachmentBlock): QueuedAttachment {
  return {
    tempId: attachment.attachmentId,
    attachmentId: attachment.attachmentId,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    status: 'ready',
    progress: 1,
  };
}
