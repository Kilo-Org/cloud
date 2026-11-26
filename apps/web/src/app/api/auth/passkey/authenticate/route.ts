import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';

import { callerAddressFromHeaders } from '@/lib/auth/caller-address';
import { checkFirewallRateLimit, firewallRateLimitRefusal } from '@/lib/auth/firewall-rate-limit';
import {
  createAuthenticationOptions,
  verifyAuthentication,
  PasskeyVerificationError,
} from '@/lib/auth/passkey';
import { authenticationResponseSchema } from '@/lib/auth/passkey-response';
import {
  auditAuthRoute,
  authAuditRequestFromHeaders,
  type AuthAuditAttempt,
} from '@/lib/auth/auth-audit';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';

/**
 * Vercel Firewall rate-limit rules applied by this route.
 * `passkey-authentication-options` covers `{ action: 'options' }`;
 * `passkey-authentication-verify` covers `{ action: 'verify' }`. Both rules
 * live in the project's firewall configuration and must be created there with
 * these exact ids. When a check returns an error the branch returns
 * 503 RATE_LIMIT_UNAVAILABLE; the shared check reports that condition to
 * Sentry.
 */
const OPTIONS_RATE_LIMIT_ID = 'passkey-authentication-options';
const VERIFY_RATE_LIMIT_ID = 'passkey-authentication-verify';

/**
 * Usernameless passkey sign-in. `{ action: 'options' }` mints discoverable
 * credential options and stores the challenge server-side;
 * `{ action: 'verify', challengeId, response }` verifies the assertion against
 * that stored challenge and returns a one-time `{ ticket }` the sign-in
 * provider exchanges for a session. The route is unauthenticated by design.
 *
 * Error contract: 400 invalid request, 401 `{ error }` with a stable
 * `PasskeyVerificationError` code on refusal, 429 when the client exceeds the
 * firewall rule for its action, 503 `RATE_LIMIT_UNAVAILABLE` when the firewall
 * check cannot be evaluated.
 */
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('options') }),
  z.object({
    action: z.literal('verify'),
    challengeId: z.string().uuid(),
    response: authenticationResponseSchema,
  }),
]);

export async function POST(request: NextRequest) {
  // One attempt per call. A verified assertion only mints a ticket, and the
  // sign-in that redeems it records the success, so a success writes no row
  // here. A refusal records the response's stable code, attributed to the
  // credential's account once the assertion names a stored credential.
  const attempt: AuthAuditAttempt = {
    action: 'auth.sign_in',
    method: 'passkey',
    skipSuccessRow: true,
  };
  return auditAuthRoute(
    authAuditRequestFromHeaders(request.headers, '/api/auth/passkey/authenticate'),
    attempt,
    () => authenticate(request, attempt)
  );
}

async function authenticate(request: NextRequest, attempt: AuthAuditAttempt): Promise<Response> {
  const body = await request.json().catch(() => undefined);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  attempt.metadata = { step: parsed.data.action };
  try {
    if (parsed.data.action === 'options') {
      const limit = await checkFirewallRateLimit(OPTIONS_RATE_LIMIT_ID, {
        source: 'passkey_authenticate_options',
        request,
        rateLimitKey: `passkey-options:${callerAddressFromHeaders(request.headers)}`,
      });
      const refusal = firewallRateLimitRefusal(limit);
      if (refusal) return refusal;

      const { challengeId, options } = await createAuthenticationOptions();
      return NextResponse.json({ challengeId, options });
    }

    const limit = await checkFirewallRateLimit(VERIFY_RATE_LIMIT_ID, {
      source: 'passkey_authenticate_verify',
      request,
      rateLimitKey: `passkey-verify:${callerAddressFromHeaders(request.headers)}`,
    });
    const refusal = firewallRateLimitRefusal(limit);
    if (refusal) return refusal;

    const { ticket } = await verifyAuthentication(
      parsed.data.challengeId,
      parsed.data.response,
      kiloUserId => {
        attempt.userId = kiloUserId;
      }
    );
    return NextResponse.json({ ticket });
  } catch (error) {
    if (error instanceof PasskeyVerificationError) {
      // A refusal stored under the credential's owner hashes the owner's
      // email. Only a refusal pays for the read: a success writes no row here.
      if (attempt.userId) {
        attempt.email = (await findUserById(attempt.userId))?.google_user_email ?? null;
      }
      return NextResponse.json({ error: error.code }, { status: 401 });
    }
    throw error;
  }
}
