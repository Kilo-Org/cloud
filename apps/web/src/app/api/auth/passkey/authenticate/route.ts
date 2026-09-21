import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import { checkRateLimit } from '@vercel/firewall';
import { captureMessage } from '@sentry/nextjs';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

import {
  createAuthenticationOptions,
  verifyAuthentication,
  PasskeyVerificationError,
} from '@/lib/auth/passkey';

/**
 * Vercel Firewall rate limit that caps unauthenticated challenge minting.
 * `options` needs no session and writes a `passkey_challenges` row per call, so
 * this is what stops one client from filling the table. The rule lives in the
 * project's firewall configuration; `checkRateLimit` reports an unknown id as
 * "not rate limited", so the Sentry report below is the only signal that the
 * rule has gone missing.
 */
const OPTIONS_RATE_LIMIT_ID = 'passkey-authentication-options';

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
 * `PasskeyVerificationError` code on refusal, 429 when the client is minting
 * challenges faster than the firewall rule allows.
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
      const { rateLimited, error } = await checkRateLimit(OPTIONS_RATE_LIMIT_ID, {
        request,
        rateLimitKey: `passkey-options:${clientIpAddress(request)}`,
      });
      if (error === 'not-found') {
        captureMessage(`Firewall rate limit '${OPTIONS_RATE_LIMIT_ID}' is not configured`, {
          level: 'error',
          tags: { source: 'passkey_authenticate_options' },
        });
      }
      if (rateLimited) {
        return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
      }

      const { challengeId, options } = await createAuthenticationOptions();
      return NextResponse.json({ challengeId, options });
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
