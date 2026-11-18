import { type NewSessionPrefill, resolvePrefillRepoSelection } from './new-session-prefill';

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
 * So focus is only taken when the form already has a repository, which is the
 * one piece of configuration the create cannot start without:
 *
 *  - a repository already selected on this mount, or
 *  - a route prefill that the screen will actually apply: the same condition
 *    `useNewSessionPrefillTargets` applies it under, so the list has to have
 *    settled and contain that repository. A prefill whose repository is gone,
 *    or whose provider list failed, leaves the form as unconfigured as the
 *    plain entry.
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
  /** A repository is already selected on this mount. */
  hasSelectedRepository: boolean;
  /** Every provider list has settled without error (the prefill's own gate). */
  reposSettled: boolean;
  /** The repositories the picker offers, as loaded. */
  repositories: readonly { platform: string; fullName: string }[];
  /** The repository prefill the entry carries, if any. */
  prefill: NewSessionPrefill;
};

export function shouldAutoFocusNewSessionPrompt(input: NewSessionPromptFocusInput): boolean {
  if (input.sharePrefilled) {
    return false;
  }
  if (input.hasSelectedRepository) {
    return true;
  }
  return (
    input.reposSettled &&
    resolvePrefillRepoSelection([...input.repositories], input.prefill) !== null
  );
}
