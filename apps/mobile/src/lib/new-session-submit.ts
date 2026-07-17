/**
 * Pure boolean predicate for whether the "Start session" button on the
 * new-agent screen may submit right now. Lives in `lib/` (not next to
 * the route) so the regression test for the Wave 2 C3a slice can pin
 * both halves of the contract without rendering anything:
 *
 *   1. The existing cloud-agent path is byte-identical to before this
 *      slice landed — `canCreate` is computed with the exact same
 *      expression, and `isCloudAgentTargetSelected` defaults to `true`
 *      because the route's `runOnInstance` state defaults to `null`.
 *   2. Whenever a remote target is selected, the predicate evaluates
 *      to `false` REGARDLESS of the rest of the input. The actual
 *      remote submit wiring is a later slice (C3b); until then the
 *      start button must stay inert so we cannot accidentally fire
 *      the cloud-agent path with the wrong target.
 */
export function resolveNewSessionSubmitEnabled({
  attachmentsHasFailed,
  attachmentsIsUploading,
  hasPrompt,
  isCreating,
  isRemoteTargetSelected,
  isSubmitting,
  model,
  selectedRepo,
}: {
  attachmentsHasFailed: boolean;
  attachmentsIsUploading: boolean;
  hasPrompt: boolean;
  isCreating: boolean;
  isRemoteTargetSelected: boolean;
  isSubmitting: boolean;
  model: string;
  selectedRepo: string;
}): boolean {
  const canCreate =
    hasPrompt &&
    Boolean(selectedRepo) &&
    Boolean(model) &&
    !attachmentsIsUploading &&
    !attachmentsHasFailed;

  // The remote-target case short-circuits the entire cloud-agent
  // submission path, not just `canCreate`. The Start button's `disabled`
  // prop is the OR of every blocking flag, so a single boolean here is
  // sufficient to gate both the button and any future submit call site
  // (e.g. a submit-on-enter handler C3b might add).
  if (isRemoteTargetSelected) {
    return false;
  }

  return canCreate && !isCreating && !isSubmitting;
}

/**
 * Inverse of `resolveNewSessionSubmitEnabled`, kept here so callers (and
 * tests) don't have to negate the condition at the call site.
 */
export function resolveNewSessionSubmitDisabled(input: {
  attachmentsHasFailed: boolean;
  attachmentsIsUploading: boolean;
  hasPrompt: boolean;
  isCreating: boolean;
  isRemoteTargetSelected: boolean;
  isSubmitting: boolean;
  model: string;
  selectedRepo: string;
}): boolean {
  return !resolveNewSessionSubmitEnabled(input);
}
