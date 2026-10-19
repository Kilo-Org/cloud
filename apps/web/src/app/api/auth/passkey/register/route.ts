import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';

import {
  createRegistrationOptions,
  verifyRegistration,
  PasskeyVerificationError,
} from '@/lib/auth/passkey';
import { checkFirewallRateLimit } from '@/lib/auth/firewall-rate-limit';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

/**
 * Vercel Firewall rate-limit rule applied to `{ action: 'options' }`, keyed
 * per user because the session is the actor. The rule lives in the project's
 * firewall configuration and must be created there with this exact id. When a
 * check returns an error the branch returns 503 RATE_LIMIT_UNAVAILABLE; the
 * shared check reports that condition to Sentry.
 */
const REGISTRATION_OPTIONS_RATE_LIMIT_ID = 'passkey-registration-options';

function registrationRateLimitKey(userId: string): string {
  return `passkey-register-options:${userId}`;
}

/**
 * `{ action: 'options' }` mints registration options and stores the challenge
 * server-side; `{ action: 'verify', challengeId, response }` verifies the
 * attestation against that stored challenge and binds the credential to the
 * authenticated user.
 *
 * Error contract: 400 invalid request, 401 `{ error }` with a stable
 * `PasskeyVerificationError` code on refusal, 429 when the account exceeds the
 * registration-options firewall rule, 503 `RATE_LIMIT_UNAVAILABLE` when the
 * firewall check cannot be evaluated.
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
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  const body = await request.json().catch(() => undefined);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  try {
    if (parsed.data.action === 'options') {
      const limit = await checkFirewallRateLimit(REGISTRATION_OPTIONS_RATE_LIMIT_ID, {
        source: 'passkey_register_options',
        request,
        rateLimitKey: registrationRateLimitKey(user.id),
      });
      if (limit === 'limited') {
        return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
      }
      if (limit === 'unavailable') {
        return NextResponse.json({ error: 'RATE_LIMIT_UNAVAILABLE' }, { status: 503 });
      }

      const { challengeId, options } = await createRegistrationOptions(
        user.id,
        user.google_user_email
      );
      return NextResponse.json({ challengeId, options });
    }

    const credential = await verifyRegistration(
      user.id,
      parsed.data.challengeId,
      parsed.data.response as unknown as RegistrationResponseJSON
    );
    return NextResponse.json({ credentialId: credential.credential_id });
  } catch (error) {
    if (error instanceof PasskeyVerificationError) {
      return NextResponse.json({ error: error.code }, { status: 401 });
    }
    throw error;
  }
}
