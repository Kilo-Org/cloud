import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';

import { checkFirewallRateLimit } from '@/lib/auth/firewall-rate-limit';
import { authenticationResponseSchema } from '@/lib/auth/passkey-response';
import { getWebRelyingParty } from '@/lib/auth/passkey';
import {
  createStepUpOptions,
  StepUpVerificationError,
  verifyStepUp,
} from '@/lib/auth/session-step-up';
import { getUserFromSessionForStepUp } from '@kilocode/web-shared/lib/user/server';
import { reportStepUpFailure } from '@kilocode/web-shared/lib/admin/step-up-observation';
import { stepUpIsOperationClass } from '@kilocode/web-shared/lib/admin/step-up-policy';

/**
 * Firewall rate-limit rule ids, created in the Vercel project. Until a rule
 * exists, `checkFirewallRateLimit` reports it and returns `unavailable`; the
 * route fails closed with 503 RATE_LIMIT_UNAVAILABLE.
 */
const STEP_UP_OPTIONS_RATE_LIMIT_ID = 'admin-step-up-options';
const STEP_UP_VERIFY_RATE_LIMIT_ID = 'admin-step-up-verify';

const actionClassSchema = z.enum([
  'platform_read',
  'platform_write',
  'sensitive_write',
  'support_read',
  'support_write',
  'worker_admin',
]);

const operationSchema = z.object({
  /** Stable operation identity from the privileged inventory. */
  id: z.string().min(1).max(200),
  targetKind: z.enum(['organization', 'user', 'service', 'none']),
  targetId: z.string().min(1).max(400).nullable(),
});

/**
 * A session class verifies the browser session; an operation class verifies
 * exactly one operation, so it must name the class and the binding and a
 * session class must not carry one.
 */
const bindingShape = {
  actionClass: actionClassSchema,
  operation: operationSchema.optional(),
};

function requireMatchingBinding(
  value: { actionClass: z.infer<typeof actionClassSchema>; operation?: unknown },
  ctx: z.RefinementCtx
): void {
  const isOperation = stepUpIsOperationClass(value.actionClass);
  if (isOperation && !value.operation) {
    ctx.addIssue({
      code: 'custom',
      path: ['operation'],
      message: 'An operation proof requires the operation it authorizes',
    });
  }
  if (!isOperation && value.operation) {
    ctx.addIssue({
      code: 'custom',
      path: ['operation'],
      message: 'A session proof cannot be bound to an operation',
    });
  }
}

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('options'), ...bindingShape }).superRefine(requireMatchingBinding),
  z
    .object({
      action: z.literal('verify'),
      challengeId: z.uuid(),
      response: authenticationResponseSchema,
      ...bindingShape,
    })
    .superRefine(requireMatchingBinding),
]);

function rateLimitKey(action: 'options' | 'verify', userId: string): string {
  return `admin-step-up-${action}:${userId}`;
}

/**
 * Session-bound MFA step-up for browser sessions.
 *
 * Security boundaries:
 * - Any `Authorization` header is refused: a bearer credential has no browser
 *   session to bind a proof to.
 * - The request must carry the exact web Origin. A native app or another site
 *   cannot complete a step-up even with a stolen session cookie.
 * - The caller must be a platform admin with a `webSessionId` claim minted at
 *   sign-in; a legacy session is told to sign in again.
 *
 * Error contract: 400 invalid request, 401 `{ error }` with a stable
 * `StepUpVerificationError` code (including `SESSION_UNBOUND`), 403 missing or
 * foreign Origin, 429 rate limited, 503 rate limiter unavailable.
 */
export async function POST(request: NextRequest) {
  if (request.headers.has('authorization')) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  const { expectedOrigin } = getWebRelyingParty();
  if (request.headers.get('origin') !== expectedOrigin) {
    return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
  }

  const { user, authFailedResponse, webSessionId, webSessionPepper } =
    await getUserFromSessionForStepUp();
  if (authFailedResponse) {
    return authFailedResponse;
  }
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  if (!webSessionId) {
    return NextResponse.json({ error: 'SESSION_UNBOUND' }, { status: 401 });
  }

  const body = await request.json().catch(() => undefined);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const action = parsed.data.action;
  const limit = await checkFirewallRateLimit(
    action === 'options' ? STEP_UP_OPTIONS_RATE_LIMIT_ID : STEP_UP_VERIFY_RATE_LIMIT_ID,
    {
      source: `admin_step_up_${action}`,
      request,
      rateLimitKey: rateLimitKey(action, user.id),
    }
  );
  if (limit === 'limited') {
    return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
  }
  if (limit === 'unavailable') {
    return NextResponse.json({ error: 'RATE_LIMIT_UNAVAILABLE' }, { status: 503 });
  }

  try {
    if (parsed.data.action === 'options') {
      const { challengeId, options } = await createStepUpOptions({
        userId: user.id,
        webSessionId,
        actionClass: parsed.data.actionClass,
        operation: parsed.data.operation,
      });
      return NextResponse.json({ challengeId, options });
    }

    const proof = await verifyStepUp({
      userId: user.id,
      webSessionId,
      webSessionPepper,
      challengeId: parsed.data.challengeId,
      response: parsed.data.response,
      actionClass: parsed.data.actionClass,
      operation: parsed.data.operation,
    });
    return NextResponse.json({ verified: true, expiresAt: proof.expires_at });
  } catch (error) {
    if (error instanceof StepUpVerificationError) {
      return NextResponse.json({ error: error.code }, { status: 401 });
    }
    // Drizzle errors carry statement parameters, including session hashes and
    // challenges. Report only the error shape and return an opaque failure.
    reportStepUpFailure('admin_step_up_route', error);
    return NextResponse.json({ error: 'STEP_UP_UNAVAILABLE' }, { status: 503 });
  }
}
