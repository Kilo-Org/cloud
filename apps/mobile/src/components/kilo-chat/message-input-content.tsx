import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type LayoutChangeEvent, Platform, type TextInput, View } from 'react-native';
import { type AttachmentBlock, MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTextHeight } from '@/components/agents/use-text-height';
import { applyVoiceDraftToInput } from '@/lib/voice-input/voice-input-draft';
import { useVoiceInput } from '@/lib/voice-input/use-voice-input';
import { resolveMessageInputAppStateTransition } from './message-input-app-state';
import {
  editableAttachmentToPreviewRow,
  resolveMessageInputSendDisabled,
} from './message-input-content-state';
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
import { settleVoiceInputBeforeSubmit } from '@/lib/voice-input/voice-input-submit';

const MESSAGE_INPUT_FOCUS_RESTORE_DELAY_MS = 100;
const EMPTY_READY_ATTACHMENT_BLOCKS: readonly AttachmentBlock[] = [];

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
  showInstanceCta,
  onOpenInstance,
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const submissionLockRef = useRef(false);
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
    isSubmitting ||
    submitDisabled === true ||
    resolveMessageInputSendDisabled({ canSend, disabled, overLimit });
  const controlsDisabled = disabled === true || submitDisabled === true || isSubmitting;
  const showAttachmentButton =
    attachmentQueue !== null && hasAttachmentsCapability && isEditing !== true && disabled !== true;
  const voiceDisabled =
    disabled === true || hasUploadingAttachment || isEditing === true || isSubmitting;
  const inputMeasure = useTextHeight({
    minHeight: MESSAGE_INPUT_MIN_HEIGHT,
    maxHeight: MESSAGE_INPUT_MAX_HEIGHT,
    verticalPadding: MESSAGE_INPUT_VERTICAL_INSET,
    textContentWidth: inputWidth - MESSAGE_INPUT_HORIZONTAL_PADDING,
    fontSize: MESSAGE_INPUT_FONT_SIZE,
    lineHeight: MESSAGE_INPUT_LINE_HEIGHT,
    initialText,
  });

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

  const voiceInput = useVoiceInput({
    disabled: voiceDisabled,
    getDraft: () => valueRef.current,
    onDraftChange: draft => {
      applyVoiceDraftToInput({
        input: inputRef.current,
        draft,
        maxLength: MESSAGE_TEXT_MAX_CHARS,
        onChangeText: handleChangeText,
      });
    },
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

  async function submitDraft() {
    if (disabled || submitDisabled) {
      return;
    }
    const submittedAttachmentTempIds =
      attachmentQueue?.rows.filter(row => row.status === 'ready').map(row => row.tempId) ?? [];
    const submission = submitMessageInputDraft({
      valueRef,
      replyingToMessageId: replyingTo?.id,
      onSend: async (text, inReplyToMessageId, controls) => {
        await onSendText?.(text, inReplyToMessageId, controls);
      },
      onSendContentBlocks:
        attachmentQueue === null
          ? undefined
          : async (content, inReplyToMessageId, controls) => {
              await onSendContentBlocks?.(content, inReplyToMessageId, {
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
    await submission?.completion;
  }

  async function submit() {
    await settleVoiceInputBeforeSubmit({
      lock: submissionLockRef,
      onPendingChange: setIsSubmitting,
      settleVoiceInput: voiceInput.settleBeforeSubmit,
      submit: submitDraft,
    });
  }

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
        disabledReason={disabledReason}
        showInstanceCta={showInstanceCta}
        onOpenInstance={onOpenInstance}
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
        onSubmit={() => {
          void submit();
        }}
        onVoiceInputToggle={() => {
          void voiceInput.toggle();
        }}
        overLimit={overLimit}
        replyingTo={replyingTo}
        sendDisabled={sendDisabled}
        showAttachmentButton={showAttachmentButton}
        showCounter={showCounter}
        shouldScroll={resolveMessageInputShouldScroll(inputMeasure.height)}
        typingMembers={typingMembers}
        voiceInputActive={voiceInput.isActive}
        voiceInputAvailable={voiceInput.available}
        voiceInputDisabled={voiceDisabled}
        voiceInputStatus={voiceInput.status}
      />
    </View>
  );
}
