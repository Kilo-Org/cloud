/**
 * Whether the new-session prompt may take focus when the screen opens.
 *
 * The prompt used to focus on every entry. On a phone that raises the soft
 * keyboard before the first frame settles, and the keyboard shrinks the scroll
 * frame to roughly a third of the screen: everything below the Run on row — the
 * repository picker, the branch row, the provider cards, Changes, Environment
 * and Advanced Configuration — then sits outside the frame while Start's own
 * footer says the session cannot start yet. The configuration the session still
 * needs is what the keyboard hides. A computer entry has the same problem below
 * its own card (the launch folder and the remote hint), so it is treated the
 * same way.
 *
 * So focus is only taken when the entry already has a repository: a route
 * prefill, a recent row, or the account's auto-selection. The form can then
 * start from the first keystroke, and nothing it still needs is below the card.
 *
 * Every other entry keeps the keyboard down so the first screenful is the whole
 * form; tapping the input still focuses it, so prompt-first typing costs one tap
 * exactly where the session needed a decision first.
 *
 * A share payload vetoes focus on every entry: the payload prefills the input
 * and raising the keyboard on arrival would hide the attachment strip and Start.
 */
export type NewSessionPromptFocusInput = {
  /** The entry carries a share payload, which prefills the composer itself. */
  sharePrefilled: boolean;
  /** A repository is already selected. */
  hasSelectedRepository: boolean;
  /** The route carries a repository prefill that resolves once the list settles. */
  hasRepositoryPrefill: boolean;
};

export function shouldAutoFocusNewSessionPrompt(input: NewSessionPromptFocusInput): boolean {
  if (input.sharePrefilled) {
    return false;
  }
  return input.hasSelectedRepository || input.hasRepositoryPrefill;
}
