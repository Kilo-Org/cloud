/**
 * Observe-only contract for privileged platform access.
 *
 * This module defines the vocabulary and measurement only; it does not deny
 * anything. Keep it dependency-free so both `apps/web` and
 * `packages/web-shared` can import it from any runtime boundary, including
 * tests.
 */

export type PrivilegedCredentialKind =
  | 'session'
  | 'human_bearer'
  | 'delegated_workload'
  | 'service_assertion';

export type PrivilegedActionClass =
  | 'platform_read'
  | 'platform_write'
  | 'sensitive_write'
  | 'support_read'
  | 'support_write'
  | 'worker_admin';

export type PrivilegedTargetKind = 'organization' | 'user' | 'service' | 'none';

export type PrivilegedTarget = {
  kind: PrivilegedTargetKind;
  id: string | null;
};

export type PlatformAdminPermissions = {
  isAdmin: boolean;
  isSuperAdmin: boolean;
  canViewSessions: boolean;
  canManageCredits: boolean;
  canExportApiRequestLogs: boolean;
};

export type AdminStepUpState =
  /** Measurement did not run (for example, step-up mode is off). */
  | { status: 'absent' }
  /** The session predates the per-session claim and cannot be bound to a proof. */
  | { status: 'session_unbound' }
  /** The actor has no passkey enrolled, so no step-up proof can be minted. */
  | { status: 'not_enrolled' }
  /** The actor is enrolled but has no live proof for this session and action. */
  | { status: 'required' }
  | { status: 'expired'; verifiedAt: string }
  /** The newest proof for this session and action was explicitly revoked. */
  | { status: 'revoked'; verifiedAt: string }
  | {
      status: 'fresh';
      method: 'webauthn_uv';
      verifiedAt: string;
      expiresAt: string;
    };

export type SupportGrantSlot = {
  grantId: string;
  organizationId: string;
  actionClass: 'support_read' | 'support_write';
  expiresAt: string;
};

/**
 * Privileged identity only: who is acting as a platform admin, what they may
 * do, and how strongly they proved it. User authentication (the `User` row and
 * its session) stays in the existing auth layer and is passed in by reference
 * (the user id), never folded into this type.
 */
export type AdminAssurance = {
  userId: string;
  permissions: PlatformAdminPermissions;
  stepUp: AdminStepUpState;
  supportGrant: SupportGrantSlot | null;
};

export type PrivilegedAction = {
  actionClass: PrivilegedActionClass;
  target: PrivilegedTarget;
  /** Stable id from the checked-in inventory, when one matched. */
  inventoryId: string | null;
};

export type PrivilegedActor = {
  assurance: AdminAssurance;
  credential: PrivilegedCredentialKind;
  tokenSource: string | null;
  action: PrivilegedAction;
};

export type CredentialProvenanceInput = {
  /** True when the request carried any `Authorization` header. */
  authViaToken: boolean;
  tokenSource?: string | null;
  /** Internal-service tokens minted for trusted callers. */
  internalApiUse?: boolean;
  /** A verified runtime-proxy attestation or scoped Cloud Agent authority. */
  serviceAssertion?: boolean;
  /** A scoped, delegated Cloud Agent authority that is still a workload. */
  delegatedWorkload?: boolean;
};

/**
 * Sources that mint a token for an agent, bot, or background workflow. They are
 * not a human sitting at a browser, even when the underlying user is an admin.
 * Anything else that arrives as a bearer token is treated as a human bearer
 * key, which is the credential class this telemetry alerts on.
 */
const DELEGATED_WORKLOAD_TOKEN_SOURCES = new Set([
  'cloud-agent',
  'code-review',
  'security-agent',
  'kilo-bot',
  'kilo-chat',
  'mcp-catalog',
  'internal-bot',
  'discord-bot',
]);

export function deriveCredentialKind(input: CredentialProvenanceInput): PrivilegedCredentialKind {
  if (!input.authViaToken) return 'session';
  if (input.serviceAssertion || input.internalApiUse) return 'service_assertion';
  if (
    input.delegatedWorkload ||
    (input.tokenSource && DELEGATED_WORKLOAD_TOKEN_SOURCES.has(input.tokenSource))
  ) {
    return 'delegated_workload';
  }
  return 'human_bearer';
}

export function describePrivilegedAction(
  actionClass: PrivilegedActionClass,
  target: PrivilegedTarget = { kind: 'none', id: null },
  inventoryId: string | null = null
): PrivilegedAction {
  return { actionClass, target, inventoryId };
}
export const ADMIN_STEP_UP_ABSENT: AdminStepUpState = { status: 'absent' };

export function createAdminAssurance(params: {
  userId: string;
  permissions: PlatformAdminPermissions;
  supportGrant?: SupportGrantSlot | null;
  stepUp?: AdminStepUpState;
}): AdminAssurance {
  return {
    userId: params.userId,
    permissions: params.permissions,
    stepUp: params.stepUp ?? ADMIN_STEP_UP_ABSENT,
    supportGrant: params.supportGrant ?? null,
  };
}

export type StepUpErrorCode =
  | 'MFA_REQUIRED'
  | 'MFA_EXPIRED'
  | 'NOT_ENROLLED'
  | 'SESSION_UNBOUND'
  | 'BEARER_NOT_ALLOWED'
  | 'REAUTH_REQUIRED'
  | 'STEP_UP_UNAVAILABLE';

/**
 * Cause attached to a FORBIDDEN tRPC error when enforcement refuses a request
 * for missing or stale step-up. The error formatter exposes only these fields
 * as `data.stepUp`, never the underlying session or proof.
 */
export class StepUpRequiredError extends Error {
  readonly code: StepUpErrorCode;
  readonly actionClass: PrivilegedActionClass;
  readonly purpose: 'session' | 'operation';
  readonly maxAgeSeconds: number;

  constructor(params: {
    code: StepUpErrorCode;
    actionClass: PrivilegedActionClass;
    purpose: 'session' | 'operation';
    maxAgeSeconds: number;
  }) {
    super(params.code);
    this.name = 'StepUpRequiredError';
    this.code = params.code;
    this.actionClass = params.actionClass;
    this.purpose = params.purpose;
    this.maxAgeSeconds = params.maxAgeSeconds;
  }
}
