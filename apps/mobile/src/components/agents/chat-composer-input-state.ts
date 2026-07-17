type ChatComposerControlInput = {
  attachmentsCount: number;
  attachmentMax: number;
  disabled: boolean;
  hasText: boolean;
  isFocused: boolean;
  isSending: boolean;
  isStreaming: boolean;
  voiceInputActive: boolean;
};

type ChatComposerControlState = {
  /** Backend requires a non-empty prompt even with attachments. */
  canSend: boolean;
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
    attachmentMax,
    disabled,
    hasText,
    isFocused,
    isSending,
    isStreaming,
    voiceInputActive,
  } = input;
  const toolbarDisabled = disabled || isStreaming || isSending;
  const voiceDisabled = toolbarDisabled;
  const paperclipDisabled =
    toolbarDisabled || voiceInputActive || attachmentsCount >= attachmentMax;
  const inputEditable = !toolbarDisabled && !voiceInputActive;
  const showToolbar = isFocused || hasText || attachmentsCount > 0 || voiceInputActive;
  return {
    canSend: hasText && !disabled && !isStreaming && !isSending,
    inputAccessibilityDisabled: !inputEditable,
    inputEditable,
    paperclipDisabled,
    showToolbar,
    toolbarDisabled,
    voiceDisabled,
  };
}
