/**
 * Pure gate for the "Start session" primary button on the ready branch of
 * the local-session create screen. The button must be enabled only when:
 *
 * - the controller has resolved a complete selection (fence + agent + model);
 * - the user has typed a non-blank prompt (text state is `hasPrompt === true`);
 * - the orchestrator hook reports `canSubmit === true` (its own internal
 *   conjunction of selection + prompt + idle phase);
 * - no submit is currently in flight (`isSubmitting === false`).
 *
 * Whitespace-only input fails the `hasPrompt` check at the source — that
 * flag is set by `setHasPrompt(text.trim().length > 0)` upstream. The helper
 * never inspects prompt content; it only consults the four guards so the
 * screen stays a pure function of the hook's return value plus the
 * controller's view-model.
 */
type StartSessionEnablement = {
  isReadySelection: boolean;
  hasPrompt: boolean;
  canSubmit: boolean;
  isSubmitting: boolean;
};

export function isStartSessionEnabled(input: StartSessionEnablement): boolean {
  return input.isReadySelection && input.hasPrompt && input.canSubmit && !input.isSubmitting;
}
