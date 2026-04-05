import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import jwt from 'jsonwebtoken';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import type { TurnstileJwtPayload } from '@/lib/user.server';
import { sentryLogger } from '@/lib/utils.server';

/**
 * Verify Turnstile JWT cookie and validate IP address.
 * Returns the verified token payload or an error response.
 *
 * @param context - Context string for logging (e.g., 'check-domain', 'sso-organizations')
 * @returns Verified token payload on success, or NextResponse with error on failure
 */
export async function verifyTurnstileJWT(
  context: string
): Promise<
  { success: true; token: TurnstileJwtPayload } | { success: false; response: NextResponse }
> {
  const warnInSentry = sentryLogger(context, 'warning');

  // Validate Turnstile JWT cookie
  const userCookies = await cookies();
  const turnstileJwtCookie = userCookies.get('turnstile_jwt');

  if (!turnstileJwtCookie?.value) {
    warnInSentry('SECURITY: Missing Turnstile verification token');
    return {
      success: false,
      response: NextResponse.json({ error: 'Security verification required' }, { status: 401 }),
    };
  }

  let verifiedToken: TurnstileJwtPayload;
  try {
    verifiedToken = jwt.verify(turnstileJwtCookie.value, NEXTAUTH_SECRET, {
      algorithms: ['HS256'],
    }) as unknown as TurnstileJwtPayload;
  } catch (error) {
    warnInSentry(
      'SECURITY: Invalid Turnstile JWT: ' + (error instanceof Error ? error.message : String(error))
    );
    return {
      success: false,
      response: NextResponse.json({ error: 'Invalid security verification' }, { status: 401 }),
    };
  }

  // Validate IP address matches
  const headersList = await headers();
  const forwardedFor = headersList.get('x-forwarded-for');

  if (!forwardedFor) {
    warnInSentry('SECURITY: Missing x-forwarded-for header during JWT verification');
    return {
      success: false,
      response: NextResponse.json({ error: 'Security verification failed' }, { status: 401 }),
    };
  }

  // Extract first IP from comma-separated list (client IP, ignoring proxy IPs)
  const currentIP = forwardedFor.split(',')[0]?.trim();

  if (!currentIP || verifiedToken.ip !== currentIP) {
    warnInSentry(
      `SECURITY: IP mismatch - JWT: ${verifiedToken.ip}, Current: ${currentIP || 'null'}`
    );
    return {
      success: false,
      response: NextResponse.json({ error: 'Security verification failed' }, { status: 401 }),
    };
  }

  return { success: true, token: verifiedToken };
}
