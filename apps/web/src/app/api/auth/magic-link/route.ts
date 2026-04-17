import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createMagicLinkToken } from '@/lib/auth/magic-link-tokens';
import { sendMagicLinkEmail } from '@/lib/email';
import { verifyTurnstileJWT } from '@/lib/auth/verify-turnstile-jwt';
import * as z from 'zod';
import { findUserByEmail } from '@/lib/user';
import { validateMagicLinkSignupEmail } from '@/lib/schemas/email';
import { isEmailBlacklistedByDomainAsync, isBlockedTLD } from '@/lib/user.server';

const requestSchema = z.object({
  email: z.string().email(),
  callbackUrl: z.string().optional(),
});

/**
 * API route to request a magic link.
 * Validates Turnstile token, creates a magic link token, and sends email.
 *
 * For NEW users (signup), enforces:
 * - Email must be lowercase
 * - Email cannot contain a + character
 *
 * For EXISTING users (sign-in), these restrictions are NOT enforced.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const validation = requestSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json({ success: false, error: 'Invalid request data' }, { status: 400 });
  }

  const { email, callbackUrl } = validation.data;
  const turnstileResult = await verifyTurnstileJWT('magic-link');
  if (!turnstileResult.success) {
    return turnstileResult.response;
  }

  if (await isEmailBlacklistedByDomainAsync(email)) {
    return NextResponse.json({ success: false, error: 'BLOCKED' }, { status: 403 });
  }

  // Check if this is an existing user (sign-in) or new user (signup)
  const existingUser = await findUserByEmail(email);

  // For new users, enforce stricter email validation and TLD blocking
  if (!existingUser) {
    if (isBlockedTLD(email)) {
      return NextResponse.json({ success: false, error: 'BLOCKED' }, { status: 403 });
    }
    const signupValidation = validateMagicLinkSignupEmail(email);
    if (!signupValidation.valid) {
      return NextResponse.json({ success: false, error: signupValidation.error }, { status: 400 });
    }
  }

  const magicLink = await createMagicLinkToken(email);
  const result = await sendMagicLinkEmail(magicLink, callbackUrl);

  if (!result.sent) {
    if (result.reason === 'neverbounce_rejected') {
      return NextResponse.json(
        {
          success: false,
          error: 'Unable to deliver email to this address. Please use a different email.',
        },
        { status: 400 }
      );
    }
    // provider_not_configured — internal issue, don't blame the user's email
    return NextResponse.json(
      { success: false, error: 'An internal error occurred. Please try again later.' },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    message: 'Magic link sent to your email',
  });
}
