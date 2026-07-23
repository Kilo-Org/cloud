import type { PreparationAttempt, PreparationStepSnapshot } from './types';

/**
 * Steps `ensureWrapper` emits unconditionally on every message delivery, even
 * when reusing a warm sandbox/wrapper. Their presence alone does not prove a
 * cold start happened.
 */
const SYNTHETIC_PREPARATION_STEPS = new Set<PreparationStepSnapshot['key']>([
  'sandbox_provision',
  'sandbox_boot',
]);

/**
 * A completed attempt that only ever ran the always-on sandbox acquisition/boot
 * markers performed no real environment provisioning (warm reuse). Hide its
 * "Environment prepared" indicator so it surfaces only true cold starts.
 * Running attempts are never treated as no-ops: their substantive steps may
 * still arrive, and hiding them would risk suppressing live cold-start progress.
 */
export function isNoOpCompletedPreparationAttempt(attempt: PreparationAttempt): boolean {
  if (attempt.status !== 'completed') return false;
  return attempt.steps.every(step => SYNTHETIC_PREPARATION_STEPS.has(step.key));
}
