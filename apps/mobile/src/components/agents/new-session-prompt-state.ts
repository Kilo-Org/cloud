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
  /**
   * Whether the controls that mutate the draft or the payload — the paste
   * button, its async clipboard read, and the insert-newline button — are
   * locked. True only while a create is in flight: the create already holds
   * its own snapshot, so a late clipboard read or a newline must not land in
   * the draft behind it.
   */
  draftMutationLocked: boolean;
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
 * integrates here too: an active voice session locks the attachment picker
 * while speech is being recognized, but it keeps the prompt editable so
 * dictation can insert at the caret. It does not by itself disable the
 * create button (Create only fires after the user presses "Start session").
 *
 * An in-flight create (`isCreating`) locks the create button, voice, the
 * paperclip and the draft-mutating controls, but it never makes the prompt
 * read-only. Setting `editable={false}` on a focused Android input drops the
 * IME the instant the create starts; the keyboard-lift padding under the
 * pinned footer then collapses and slides the busy Start button down the
 * screen, so the busy state no longer sits in the slot the user tapped
 * (emulator-5554: 63px, 2026-09-21). The create's gates are `createDisabled`
 * and the locked controls, so an editable prompt cannot start a second
 * session.
 */
export function resolveNewSessionPromptControlState(
  input: NewSessionPromptControlInput
): NewSessionPromptControlState {
  const { attachmentsCount, attachmentMax, isCreating, rawPrompt, voiceInputActive } = input;
  const hasPrompt = rawPrompt.trim().length > 0;
  const createDisabled = isCreating;
  const voiceDisabled = isCreating;
  const paperclipDisabled = isCreating || voiceInputActive || attachmentsCount >= attachmentMax;
  return {
    createDisabled,
    draftMutationLocked: isCreating,
    hasPrompt,
    paperclipDisabled,
    voiceDisabled,
  };
}
