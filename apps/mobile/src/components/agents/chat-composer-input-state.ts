type ChatComposerControlInput = {
  attachmentsCount: number;
  /** Number of attachments that are NOT terminally rejected (`status === 'error' && terminal === true`). */
  sendableAttachmentsCount: number;
  attachmentMax: number;
  disabled: boolean;
  hasText: boolean;
  isFocused: boolean;
  isSending: boolean;
  /** True while an attachment upload is in flight; blocks send until it settles. */
  isUploading: boolean;
  voiceInputActive: boolean;
};

type ChatComposerControlState = {
  /** Backend accepts an empty prompt when at least one attachment is sendable. */
  canSend: boolean;
  /** True when there is text or a sendable attachment, regardless of upload/send locks. */
  hasSendableContent: boolean;
  /** Mirrors `editable` on the text input. */
  inputEditable: boolean;
  /** Mirrors `accessibilityState.disabled` on the text input. */
  inputAccessibilityDisabled: boolean;
  /** Drives the attachment picker. */
  paperclipDisabled: boolean;
  /** Toolbar (mode/variant/model row) visibility. */
  showToolbar: boolean;
  /** Latches the toolbar's mode/model controls while send, stream, or disabled. */
  toolbarDisabled: boolean;
  /** Mirrors `useVoiceInput`'s `disabled` — toolbar-disabled is the gate. */
  voiceDisabled: boolean;
};

/**
 * Pure projection of the Cloud Agent `ChatComposer` control surface. Keeping
 * the rules in one place lets the component stay a thin presenter and makes
 * every state — happy, blocked, and listening — testable without rendering
 * the composer. Voice input integrates here too: an active voice session
 * makes the input read-only and locks the attachment picker while speech is
 * being recognized.
 */
export function resolveChatComposerControlState(
  input: ChatComposerControlInput
): ChatComposerControlState {
  const {
    attachmentsCount,
    sendableAttachmentsCount,
    attachmentMax,
    disabled,
    hasText,
    isFocused,
    isSending,
    isUploading,
    voiceInputActive,
  } = input;
  // Streaming is intentionally NOT a composer gate. The user must be able to
  // type and send while the agent runs (plan §3.3): the row component chooses
  // Stop vs Send based on `isStreaming` + `hasText`. The session manager, the
  // parent, and `disabled` cover every other lock (read-only, missing model,
  // blocking interaction, interrupt-in-flight); `isUploading` covers the
  // upload-in-progress lock.
  const toolbarDisabled = disabled || isSending;
  const voiceDisabled = toolbarDisabled;
  const paperclipDisabled =
    toolbarDisabled || voiceInputActive || attachmentsCount >= attachmentMax;
  const inputEditable = !toolbarDisabled && !voiceInputActive;
  const showToolbar = isFocused || hasText || attachmentsCount > 0 || voiceInputActive;
  const hasSendableContent = hasText || sendableAttachmentsCount > 0;
  return {
    canSend: hasSendableContent && !disabled && !isSending && !isUploading,
    hasSendableContent,
    inputAccessibilityDisabled: !inputEditable,
    inputEditable,
    paperclipDisabled,
    showToolbar,
    toolbarDisabled,
    voiceDisabled,
  };
}
