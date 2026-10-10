/**
 * The uncontrolled prompt input's remount seed. `pending` is the initial and
 * re-armed state while the identity-bound draft loads; `settled` means the
 * input already shows the right text; `restore` is the only value that changes
 * the form key and remounts the input onto a stored draft.
 */
export type NewSessionPromptSeed = 'pending' | 'settled' | 'restore';

/** What the seed effect should do for one render. */
export type NewSessionPromptSeedDecision =
  | { type: 'keep' }
  | { type: 'reset' }
  | { type: 'settle' }
  | { type: 'restore'; prompt: string; hasPrompt: boolean; seed: NewSessionPromptSeed };

export type NewSessionPromptSeedInput = {
  draftSettled: boolean;
  seed: NewSessionPromptSeed;
  prompt: string;
  initialPrompt: string | undefined;
  sharePrefillText: string | null;
  /** Whether the user edited the prompt (including clearing it) before the load settled. */
  userEdited: boolean;
};

/**
 * Resolves the seed effect's action from the draft-load and prompt state.
 *
 * The prompt input is uncontrolled: only a `restore` decision remounts it onto
 * a stored draft. A prompt the user edited before the identity-bound draft
 * load settled — including one the user cleared back to empty — is already the
 * input's visible text, so it must settle in place instead of being treated as
 * an untouched empty ref and overwritten by an older saved draft.
 */
export function resolveNewSessionPromptSeedDecision(
  input: NewSessionPromptSeedInput
): NewSessionPromptSeedDecision {
  const { draftSettled, seed, prompt, initialPrompt, sharePrefillText, userEdited } = input;
  if (!draftSettled) {
    if (seed === 'pending') {
      return { type: 'keep' };
    }
    // The identity or entity changed. A `restore` seed is a stored draft the
    // input remounts away, so reset the route-owned prompt with it. A
    // `settled` seed keeps its non-empty text: the remount key stays `empty`,
    // so resetting the route-owned prompt would desync it from the visible
    // field.
    if (seed === 'settled' && prompt !== '') {
      return { type: 'keep' };
    }
    return { type: 'reset' };
  }
  if (seed !== 'pending') {
    return { type: 'keep' };
  }
  // An explicit pre-identity edit beats a stored draft, even when the edit is
  // an intentional clear to empty: the input already shows it, and a restore
  // would remount the older text over it.
  if (prompt !== '' || userEdited || !initialPrompt) {
    return { type: 'settle' };
  }
  return {
    type: 'restore',
    prompt: initialPrompt,
    hasPrompt: initialPrompt.trim().length > 0,
    // A share prefill already seeded the first render; only a stored draft
    // needs the remount.
    seed: initialPrompt === sharePrefillText ? 'settled' : 'restore',
  };
}
