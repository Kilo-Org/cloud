type NewSessionPromptControlInput = {
  attachmentsCount: number;
  attachmentMax: number;
  isCreating: boolean;
  rawPrompt: string;
  voiceInputActive: boolean;
};

type NewSessionPromptControlState = {
  /** Mirrors the "Start session" button's disabled state. */
  createDisabled: boolean;
  /** Whether the prompt has non-whitespace text — the upstream canCreate gate. */
  hasPrompt: boolean;
  /** Whether the prompt row itself can be tapped into for typing. */
  inputEditable: boolean;
  /** Mirrors `accessibilityState.disabled` on the TextInput. */
  inputAccessibilityDisabled: boolean;
  /** Whether the paperclip / "Add attachment" press is locked. */
  paperclipDisabled: boolean;
  /** Mirrors `useVoiceInput`'s `disabled` flag — only isCreating gates voice. */
  voiceDisabled: boolean;
};

/**
 * Validates the live, post-settlement prompt value for `createSession`.
 * Returns the trimmed prompt when the user has something to send, or `null`
 * when the live draft is empty or whitespace-only — for example when an
 * interim voice transcript was replaced by an empty final transcript (no
 * speech recognized). Returning `null` lets the caller no-op without
 * firing prepareSession, surfacing a toast, or navigating. The empty case
 * is its own supported state: the voice controller has already presented
 * its own "no speech" feedback, so the composer should preserve the
 * user's draft and screen state.
 */
export function resolveNewSessionPromptForCreate(rawPrompt: string): string | null {
  const trimmed = rawPrompt.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Pure projection of the new-session prompt row's gating state. The
 * component file stays a thin presenter and every state — happy, in-flight,
 * voice-active — is testable without rendering React Native. Voice input
 * integrates here too: an active voice session makes the prompt read-only
 * and locks the attachment picker while speech is being recognized, but it
 * does not by itself disable the create button (Create only fires after the
 * user presses "Start session").
 */
export function resolveNewSessionPromptControlState(
  input: NewSessionPromptControlInput
): NewSessionPromptControlState {
  const { attachmentsCount, attachmentMax, isCreating, rawPrompt, voiceInputActive } = input;
  const hasPrompt = rawPrompt.trim().length > 0;
  const createDisabled = isCreating;
  const voiceDisabled = isCreating;
  const paperclipDisabled = isCreating || voiceInputActive || attachmentsCount >= attachmentMax;
  const inputEditable = !isCreating && !voiceInputActive;
  return {
    createDisabled,
    hasPrompt,
    inputAccessibilityDisabled: !inputEditable,
    inputEditable,
    paperclipDisabled,
    voiceDisabled,
  };
}
