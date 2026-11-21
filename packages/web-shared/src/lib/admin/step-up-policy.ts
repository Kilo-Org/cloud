import type { PrivilegedActionClass } from '@kilocode/web-shared/lib/admin/privileged-access';

/**
 * Two step-up policies.
 *
 * Read-grade classes and `platform_write` use one session policy: a passkey
 * verification proves it is the admin for the next 30 minutes.
 *
 * The three classes that change another account or the platform configuration
 * use one operation policy: every proof names the single action class and the
 * single operation it was minted for, including the target account where the
 * caller knows it. The guard claims the proof when it authorizes the request,
 * so a proof authorizes one operation and is spent.
 */
export const STEP_UP_ORDINARY_TTL_MS = 30 * 60 * 1000;
export const STEP_UP_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS = 10 * 60 * 1000;
export const STEP_UP_RETENTION_AFTER_EXPIRY_MS = 24 * 60 * 60 * 1000;

export type StepUpProofPurpose = 'session' | 'operation';

export type StepUpPolicy = {
  purpose: StepUpProofPurpose;
  maxAgeMs: number;
  /**
   * Whether a route may opt a non-session credential kind out of step-up
   * through `stepUpExemptCredentials`. Only read-grade classes qualify: an
   * exempted caller must not be able to change another account or the platform
   * configuration. A class that is not exemptible keeps the guard even when the
   * route asks for an exemption.
   */
  credentialExemptible: boolean;
};

const SESSION_READ: StepUpPolicy = {
  purpose: 'session',
  maxAgeMs: STEP_UP_ORDINARY_TTL_MS,
  credentialExemptible: true,
};

const SESSION_WRITE: StepUpPolicy = {
  purpose: 'session',
  maxAgeMs: STEP_UP_ORDINARY_TTL_MS,
  credentialExemptible: false,
};

const OPERATION: StepUpPolicy = {
  purpose: 'operation',
  maxAgeMs: STEP_UP_CHALLENGE_TTL_MS,
  credentialExemptible: false,
};

export const STEP_UP_POLICY: Record<PrivilegedActionClass, StepUpPolicy> = {
  platform_read: SESSION_READ,
  platform_write: SESSION_WRITE,
  sensitive_write: OPERATION,
  support_read: SESSION_READ,
  support_write: OPERATION,
  worker_admin: OPERATION,
};

export function stepUpPolicyFor(actionClass: PrivilegedActionClass): StepUpPolicy {
  return STEP_UP_POLICY[actionClass];
}

export function isCredentialExemptibleClass(actionClass: PrivilegedActionClass): boolean {
  return STEP_UP_POLICY[actionClass].credentialExemptible;
}

export function isOperationStepUpClass(actionClass: PrivilegedActionClass): boolean {
  return STEP_UP_POLICY[actionClass].purpose === 'operation';
}
