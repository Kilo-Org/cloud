import type { PrivilegedActionClass } from '@kilocode/web-shared/lib/admin/privileged-access';

/**
 * Two step-up policies.
 *
 * Read-grade and ordinary write classes share one session proof: a passkey
 * verification bound to the browser session, reusable for `STEP_UP_ORDINARY_TTL_MS`.
 *
 * Sensitive writes, support writes and worker administration require a
 * per-operation proof instead: one WebAuthn verification bound to one
 * operation of the checked-in privileged inventory, valid for
 * `STEP_UP_CHALLENGE_TTL_MS` and consumed by the single operation it authorizes.
 */
export const STEP_UP_ORDINARY_TTL_MS = 30 * 60 * 1000;
export const STEP_UP_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS = 10 * 60 * 1000;
export const STEP_UP_RETENTION_AFTER_EXPIRY_MS = 24 * 60 * 60 * 1000;

export type StepUpProofPurpose = 'session' | 'operation';

export type StepUpPolicy = {
  purpose: StepUpProofPurpose;
  maxAgeMs: number;
};

const SESSION: StepUpPolicy = {
  purpose: 'session',
  maxAgeMs: STEP_UP_ORDINARY_TTL_MS,
};

const OPERATION: StepUpPolicy = {
  purpose: 'operation',
  maxAgeMs: STEP_UP_CHALLENGE_TTL_MS,
};

export const STEP_UP_POLICY: Record<PrivilegedActionClass, StepUpPolicy> = {
  platform_read: SESSION,
  platform_write: SESSION,
  sensitive_write: OPERATION,
  support_read: SESSION,
  support_write: OPERATION,
  worker_admin: OPERATION,
};

export function stepUpPolicyFor(actionClass: PrivilegedActionClass): StepUpPolicy {
  return STEP_UP_POLICY[actionClass];
}

/** True when this class needs a proof bound to one operation, not to the session. */
export function stepUpIsOperationClass(actionClass: PrivilegedActionClass): boolean {
  return STEP_UP_POLICY[actionClass].purpose === 'operation';
}
