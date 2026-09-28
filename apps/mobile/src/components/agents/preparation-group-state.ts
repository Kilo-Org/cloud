import { type PreparationAttempt, type PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';

/**
 * The named step the wrapper emits when a runtime replacement restored only
 * part of the worktree. It carries the count and the missing paths in its
 * `safeError`, so the group must not hide it behind a green "Preparation
 * complete". Mirrors the web preparation row.
 */
const RESTORE_INCOMPLETE_STEP_KEY = 'restore_incomplete';

export function findRestoreIncompleteStep(
  attempt: PreparationAttempt
): PreparationStepSnapshot | undefined {
  return attempt.steps.find(step => step.key === RESTORE_INCOMPLETE_STEP_KEY);
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
