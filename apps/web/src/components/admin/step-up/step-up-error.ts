import * as z from 'zod';
import type { StepUpErrorCode } from '@kilocode/web-shared/lib/admin/privileged-access';

export type StepUpOperationRequirement = {
  id: string;
  targetKind: 'organization' | 'user' | 'service' | 'none';
  targetId: string | null;
};

export type StepUpRequirement = {
  code: StepUpErrorCode;
  actionClass?: string;
  purpose?: 'session' | 'operation';
  maxAgeSeconds?: number;
  /** The operation an `operation` proof must be minted for. */
  operation?: StepUpOperationRequirement;
};

export class StepUpCancelledError extends Error {
  constructor() {
    super('Step-up cancelled');
    this.name = 'StepUpCancelledError';
  }
}

const STEP_UP_CODES = [
  'MFA_REQUIRED',
  'MFA_EXPIRED',
  'NOT_ENROLLED',
  'SESSION_UNBOUND',
  'BEARER_NOT_ALLOWED',
  'REAUTH_REQUIRED',
  'STEP_UP_UNAVAILABLE',
] as const satisfies readonly StepUpErrorCode[];

const stepUpOperationSchema = z.object({
  id: z.string().min(1),
  targetKind: z.enum(['organization', 'user', 'service', 'none']),
  targetId: z.string().nullable(),
});

const stepUpPayloadSchema = z.object({
  code: z.enum(STEP_UP_CODES),
  actionClass: z.string().optional(),
  purpose: z.enum(['session', 'operation']).optional(),
  maxAgeSeconds: z.number().optional(),
  operation: stepUpOperationSchema.optional(),
});

/**
 * Read one step-up payload: the tRPC `data.stepUp` object and the REST
 * `stepUp` field carry the same shape. An unknown shape is ignored, never trusted.
 */
function parseStepUpPayload(value: unknown): StepUpRequirement | null {
  const parsed = stepUpPayloadSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data;
}

/**
 * Read the formatter's `data.stepUp` contract without importing a client
 * error class, so it works for tRPC errors from any link or transport.
 */
export function stepUpRequirementFromError(error: unknown): StepUpRequirement | null {
  if (typeof error !== 'object' || error === null) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const stepUp = (data as { stepUp?: unknown }).stepUp;
  if (typeof stepUp !== 'object' || stepUp === null) return null;
  return parseStepUpPayload(stepUp);
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
 * Read the REST 403 refusal body used by adminOnly routes. A step-up refusal
 * carries `stepUp` next to the error code; without it only the code is known.
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
  const stepUp = parseStepUpPayload((body as { stepUp?: unknown }).stepUp);
  if (stepUp) return stepUp;
  const code = (body as { error?: unknown }).error;
  const parsedCode = stepUpPayloadSchema.shape.code.safeParse(code);
  return parsedCode.success ? { code: parsedCode.data } : null;
}
