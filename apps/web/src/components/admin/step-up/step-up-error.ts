import * as z from 'zod';
import {
  PRIVILEGED_ACTION_CLASSES,
  type PrivilegedActionClass,
  type StepUpErrorCode,
  type StepUpOperationBinding,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import { stepUpOperationSchema } from '@kilocode/web-shared/lib/admin/step-up-binding';

export type StepUpRequirement = {
  code: StepUpErrorCode;
  actionClass?: PrivilegedActionClass;
  purpose?: 'session' | 'operation';
  maxAgeSeconds?: number;
  /** The operation an operation-class proof must be minted for. */
  binding?: StepUpOperationBinding;
};

export class StepUpCancelledError extends Error {
  constructor(requirement: StepUpRequirement) {
    super('Step-up cancelled');
    this.name = 'StepUpCancelledError';
    this.data = { stepUp: requirement };
  }

  readonly data: { stepUp: StepUpRequirement };
}

const stepUpRequirementSchema = z.object({
  code: z.enum([
    'MFA_REQUIRED',
    'MFA_EXPIRED',
    'NOT_ENROLLED',
    'SESSION_UNBOUND',
    'BEARER_NOT_ALLOWED',
    'REAUTH_REQUIRED',
    'STEP_UP_UNAVAILABLE',
  ]),
  actionClass: z.enum(PRIVILEGED_ACTION_CLASSES).optional(),
  purpose: z.enum(['session', 'operation']).optional(),
  maxAgeSeconds: z.number().optional(),
  binding: stepUpOperationSchema.nullish(),
});

/**
 * Read one client-visible step-up requirement from an untrusted payload. A
 * malformed payload reads as absent, so the caller falls back to the plain
 * session prompt instead of minting a proof for a descriptor the server cannot
 * match.
 */
export function parseStepUpRequirement(value: unknown): StepUpRequirement | null {
  const parsed = stepUpRequirementSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    code: parsed.data.code,
    actionClass: parsed.data.actionClass,
    purpose: parsed.data.purpose,
    maxAgeSeconds: parsed.data.maxAgeSeconds,
    binding: parsed.data.binding ?? undefined,
  };
}

/**
 * Read the formatter's `data.stepUp` contract without importing a client
 * error class, so it works for tRPC errors from any link or transport.
 */
export function stepUpRequirementFromError(error: unknown): StepUpRequirement | null {
  if (typeof error !== 'object' || error === null) return null;
  if (!('data' in error)) return null;
  const data = error.data;
  if (typeof data !== 'object' || data === null || !('stepUp' in data)) return null;
  return parseStepUpRequirement(data.stepUp);
}

export function stepUpDialogTitle(requirement: StepUpRequirement): string {
  switch (requirement.code) {
    case 'NOT_ENROLLED':
      return 'Add a passkey to continue';
    case 'SESSION_UNBOUND':
      return 'Sign in again to continue';
    case 'BEARER_NOT_ALLOWED':
      return 'Use a browser session';
    case 'REAUTH_REQUIRED':
      return 'Verify your sign-in';
    case 'STEP_UP_UNAVAILABLE':
      return 'Verification is temporarily unavailable';
    case 'MFA_EXPIRED':
      return 'Your verification expired';
    case 'MFA_REQUIRED':
      return 'Verify it is you';
  }
}

export function stepUpDialogDescription(requirement: StepUpRequirement): string {
  switch (requirement.code) {
    case 'NOT_ENROLLED':
      return 'Admin actions need a passkey. Add one now, then verify it to continue.';
    case 'SESSION_UNBOUND':
      return 'This browser session predates session-bound MFA. Signing out signs you out of every browser; then sign in and retry the action.';
    case 'BEARER_NOT_ALLOWED':
      return 'API tokens cannot complete MFA. Use the Kilo web console with a browser session.';
    case 'REAUTH_REQUIRED':
      return 'Sign in again before adding another passkey. Signing out signs you out of every browser.';
    case 'STEP_UP_UNAVAILABLE':
      return 'MFA verification could not be checked. Try again in a moment. If it keeps failing, contact support.';
    case 'MFA_EXPIRED':
      return 'Confirm it is you with your passkey to continue.';
    case 'MFA_REQUIRED':
      return 'Confirm it is you with your passkey to continue.';
  }
}

/** Human-readable time left on a fresh proof, rounded down to whole minutes. */
export function formatStepUpRemaining(expiresAt: string, now: number = Date.now()): string {
  const remainingMs = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'expired';
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 1) return 'less than a minute left';
  return `${minutes} min left`;
}

/**
 * Read the REST 403 `{ error, stepUp }` contract used by adminOnly routes. The
 * older `{ error }`-only refusal still reads as a plain requirement.
 */
export async function stepUpRequirementFromResponse(
  response: Response
): Promise<StepUpRequirement | null> {
  if (response.status !== 403) return null;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  if ('stepUp' in body && body.stepUp !== undefined && body.stepUp !== null) {
    const requirement = parseStepUpRequirement(body.stepUp);
    if (requirement) return requirement;
  }
  if (!('error' in body)) return null;
  const { error } = body;
  const requirement = parseStepUpRequirement({ code: error });
  return requirement;
}
