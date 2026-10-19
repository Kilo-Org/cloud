import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

import {
  createAuthenticationOptions,
  verifyAuthentication,
  PasskeyVerificationError,
} from '@/lib/auth/passkey';
import { checkFirewallRateLimit } from '@/lib/auth/firewall-rate-limit';

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

/** The client address the firewall rule counts against, from the proxy headers. */
function clientIpAddress(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

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
    response: z.record(z.string(), z.unknown()),
  }),
]);

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => undefined);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  try {
    if (parsed.data.action === 'options') {
      const limit = await checkFirewallRateLimit(OPTIONS_RATE_LIMIT_ID, {
        source: 'passkey_authenticate_options',
        request,
        rateLimitKey: `passkey-options:${clientIpAddress(request)}`,
      });
      if (limit === 'limited') {
        return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
      }
      if (limit === 'unavailable') {
        return NextResponse.json({ error: 'RATE_LIMIT_UNAVAILABLE' }, { status: 503 });
      }

      const { challengeId, options } = await createAuthenticationOptions();
      return NextResponse.json({ challengeId, options });
    }

    const limit = await checkFirewallRateLimit(VERIFY_RATE_LIMIT_ID, {
      source: 'passkey_authenticate_verify',
      request,
      rateLimitKey: `passkey-verify:${clientIpAddress(request)}`,
    });
    if (limit === 'limited') {
      return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
    }
    if (limit === 'unavailable') {
      return NextResponse.json({ error: 'RATE_LIMIT_UNAVAILABLE' }, { status: 503 });
    }

    const { ticket } = await verifyAuthentication(
      parsed.data.challengeId,
      parsed.data.response as unknown as AuthenticationResponseJSON
    );
    return NextResponse.json({ ticket });
  } catch (error) {
    if (error instanceof PasskeyVerificationError) {
      return NextResponse.json({ error: error.code }, { status: 401 });
    }
    throw error;
  }
}
