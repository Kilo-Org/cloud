import type { PrivilegedActionClass } from '@kilocode/web-shared/lib/admin/privileged-access';

/**
 * Provisional step-up policy: one freshness window for every action class.
 * Per-operation confirmation for sensitive writes is a documented follow-up.
 */
export const STEP_UP_ORDINARY_TTL_MS = 15 * 60 * 1000;
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

export const STEP_UP_POLICY: Record<PrivilegedActionClass, StepUpPolicy> = {
  platform_read: SESSION,
  platform_write: SESSION,
  sensitive_write: SESSION,
  support_read: SESSION,
  support_write: SESSION,
  worker_admin: SESSION,
};

export function stepUpPolicyFor(actionClass: PrivilegedActionClass): StepUpPolicy {
  return STEP_UP_POLICY[actionClass];
}
