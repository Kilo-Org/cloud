import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';

import {
  createRegistrationOptions,
  verifyRegistration,
  PasskeyVerificationError,
} from '@/lib/auth/passkey';
import { getUserFromAuth } from '@/lib/user/server';

/**
 * `{ action: 'options' }` mints registration options and stores the challenge
 * server-side; `{ action: 'verify', challengeId, response }` verifies the
 * attestation against that stored challenge and binds the credential to the
 * authenticated user.
 *
 * Error contract: 400 invalid request, 401 `{ error }` with a stable
 * `PasskeyVerificationError` code on refusal.
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
