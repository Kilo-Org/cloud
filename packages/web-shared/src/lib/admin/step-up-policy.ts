import type { PrivilegedActionClass } from '@kilocode/web-shared/lib/admin/privileged-access';

/**
 * Provisional step-up policy for the observe-only rollout.
 *
 * These values are named constants so product/security sign-off changes one
 * place. The coordinator chose 15 minutes for every ordinary action class
 * (including reads) and a 5 minute, single-use proof bound to one sensitive
 * action.
 */
export const STEP_UP_ORDINARY_TTL_MS = 15 * 60 * 1000;
export const STEP_UP_SENSITIVE_OPERATION_TTL_MS = 5 * 60 * 1000;
export const STEP_UP_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS = 10 * 60 * 1000;
export const STEP_UP_RETENTION_AFTER_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** PostHog release toggle for the admin enrollment/verification UI. */
export const ADMIN_STEP_UP_ENROLLMENT_FLAG = 'admin-step-up-enrollment';

export type StepUpProofPurpose = 'session' | 'operation';

export type StepUpPolicy = {
  purpose: StepUpProofPurpose;
  maxAgeMs: number;
  singleUse: boolean;
};

const ORDINARY: StepUpPolicy = {
  purpose: 'session',
  maxAgeMs: STEP_UP_ORDINARY_TTL_MS,
  singleUse: false,
};

const SENSITIVE_OPERATION: StepUpPolicy = {
  purpose: 'operation',
  maxAgeMs: STEP_UP_SENSITIVE_OPERATION_TTL_MS,
  singleUse: true,
};

export const STEP_UP_POLICY: Record<PrivilegedActionClass, StepUpPolicy> = {
  platform_read: ORDINARY,
  platform_write: ORDINARY,
  sensitive_write: SENSITIVE_OPERATION,
  support_read: ORDINARY,
  support_write: ORDINARY,
  // Worker admin surfaces are out of scope for PR2; an ordinary proof is the
  // conservative classification until a worker-aware guard exists.
  worker_admin: ORDINARY,
};

export function stepUpPolicyFor(actionClass: PrivilegedActionClass): StepUpPolicy {
  return STEP_UP_POLICY[actionClass];
}
