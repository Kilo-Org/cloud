import { type PreparationAttempt, type PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';

/**
 * The named step the wrapper emits when a runtime replacement restored only
 * part of the worktree. It carries the count and the missing paths in its
 * `safeError`, so the group must not hide it behind a green "Preparation
 * complete". Mirrors the web preparation row.
 */
const RESTORE_INCOMPLETE_STEP_KEY = 'restore_incomplete';

/**
 * The phase that owns the individual setup commands. Its own name is a progress
 * phrase ("Running setup commands"), so it never titles a failed group: the
 * failed command under it does, and without one the group keeps the generic
 * failure title.
 */
const SETUP_COMMANDS_STEP_KEY = 'setup_commands';

export function findRestoreIncompleteStep(
  attempt: PreparationAttempt
): PreparationStepSnapshot | undefined {
  return attempt.steps.find(step => step.key === RESTORE_INCOMPLETE_STEP_KEY);
}

/**
 * The phase that failed, which names a failed group's header. A failed setup
 * command outranks the phase it ran under, because that phase starts first and
 * is settled as failed with the same error; the incomplete-restore step is a
 * report rather than a stage.
 */
export function failedStageStep(attempt: PreparationAttempt): PreparationStepSnapshot | undefined {
  if (attempt.status !== 'failed') {
    return undefined;
  }
  const failed = attempt.steps.filter(
    step => step.status === 'failed' && step.key !== RESTORE_INCOMPLETE_STEP_KEY
  );
  return (
    failed.find(step => step.kind === 'setup_command') ??
    failed.find(step => step.key !== SETUP_COMMANDS_STEP_KEY)
  );
}

/**
 * The incomplete-restore text to show instead of the green "Preparation
 * complete" title, or undefined when the attempt carries no incomplete-restore
 * step. A terminal failure outranks it: the same attempt can be `failed` and
 * still carry the step, and the failure must not be masked.
 */
export function incompleteRestoreText(attempt: PreparationAttempt): string | undefined {
  if (attempt.status === 'failed') {
    return undefined;
  }
  const step = findRestoreIncompleteStep(attempt);
  return step?.safeError ?? step?.label;
}

/**
 * An incomplete restore keeps the group open so the missing-files detail is
 * visible without a tap — the invisibility this step exists to remove. Every
 * unfinished attempt already opens; a completed one opens only for this step.
 */
export function preparationGroupExpandedByDefault(attempt: PreparationAttempt): boolean {
  return attempt.status !== 'completed' || incompleteRestoreText(attempt) !== undefined;
}
