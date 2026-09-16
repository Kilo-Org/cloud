import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

import {
  createAuthenticationOptions,
  verifyAuthentication,
  PasskeyVerificationError,
} from '@/lib/auth/passkey';

/**
 * Usernameless passkey sign-in. `{ action: 'options' }` mints discoverable
 * credential options and stores the challenge server-side;
 * `{ action: 'verify', challengeId, response }` verifies the assertion against
 * that stored challenge and returns a one-time `{ ticket }` the sign-in
 * provider exchanges for a session. The route is unauthenticated by design.
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
  const body = await request.json().catch(() => undefined);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  try {
    if (parsed.data.action === 'options') {
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
