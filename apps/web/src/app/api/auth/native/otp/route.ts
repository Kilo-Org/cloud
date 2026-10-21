import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  createSignInCode,
  deleteSignInCode,
} from '@kilocode/web-shared/lib/auth/magic-link-tokens';
import { sendSignInCodeEmail } from '@kilocode/web-shared/lib/email';
import * as z from 'zod';
import { checkEmailSignInEligibility } from '@/lib/auth/email-signin-eligibility';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

const requestSchema = z.object({
  email: z.string().email(),
});

/**
 * Minimum response time for enumeration resistance.
 * Measured eligible median 21.4 ms, maximum 53.0 ms; 250 ms leaves room for
 * slower production databases while keeping latency invisible to a user typing.
 */
const RESPONSE_FLOOR_MS = 250;

async function enforceResponseFloor(startTime: number): Promise<void> {
  const elapsed = Date.now() - startTime;
  if (elapsed < RESPONSE_FLOOR_MS) {
    await new Promise(resolve => setTimeout(resolve, RESPONSE_FLOOR_MS - elapsed));
  }
}

/**
 * API route to request an email sign-in code for native mobile sign-in.
 * Validates eligibility, issues a 6-digit code, and emails it.
 *
 * Enumeration resistance: an address rejected by the signup email rules or by
 * the domain blacklist gets the same 200 { success: true, challengeId } as an
 * eligible one. That challengeId maps to no row and verifies as INVALID_CODE,
 * identical to an eligible-but-wrong-code attempt, so the response never
 * reveals whether an account exists.
 *
 * The response diverges only where the client must act on the outcome: 429
 * when the address is rate limited, 403 with ssoOrganizationId (or 503 when
 * the domain's SSO is misconfigured) when the domain requires SSO, and, for an
 * eligible address whose email cannot be sent, 400 INVALID_EMAIL when
 * NeverBounce rejects the address or 500 EMAIL_DELIVERY_FAILED otherwise.
 */
export const POST = withRestTiming('/api/auth/native/otp', async (request: Request) => {
  const startTime = Date.now();

  const body = await request.json().catch(() => undefined);
  const validation = requestSchema.safeParse(body);

  if (!validation.success) {
    await enforceResponseFloor(startTime);
    return NextResponse.json({ success: false, error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const { email } = validation.data;

  const eligibility = await checkEmailSignInEligibility(email, request as NextRequest);
  if (!eligibility.ok) {
    if (eligibility.errorCode === 'INVALID_EMAIL') {
      await enforceResponseFloor(startTime);
      return NextResponse.json({ success: true, challengeId: randomUUID() });
    }
    if (eligibility.errorCode === 'BLOCKED') {
      await enforceResponseFloor(startTime);
      return NextResponse.json({ success: true, challengeId: randomUUID() });
    }
    await enforceResponseFloor(startTime);
    return NextResponse.json(
      {
        success: false,
        error: eligibility.errorCode,
        ...(typeof eligibility.body.ssoOrganizationId === 'string'
          ? { ssoOrganizationId: eligibility.body.ssoOrganizationId }
          : {}),
      },
      { status: eligibility.status }
    );
  }

  const { code, challengeId } = await createSignInCode(email);
  const result = await sendSignInCodeEmail(email, code);
  if (!result.sent) {
    await deleteSignInCode(email, code);
    const neverbounceRejected = result.reason === 'neverbounce_rejected';
    await enforceResponseFloor(startTime);
    return NextResponse.json(
      {
        success: false,
        error: neverbounceRejected ? 'INVALID_EMAIL' : 'EMAIL_DELIVERY_FAILED',
      },
      { status: neverbounceRejected ? 400 : 500 }
    );
  }

  await enforceResponseFloor(startTime);
  return NextResponse.json({ success: true, challengeId });
});
