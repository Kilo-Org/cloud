import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import {
  verifyNativeAppleIdToken,
  verifyNativeGoogleIdToken,
  NativeIdTokenError,
} from '@/lib/auth/native-id-tokens';
import { AppleJwtClientError } from '@/lib/auth/apple-jwks';
import { verifyAndConsumeSignInCode } from '@/lib/auth/magic-link-tokens';
import { hosted_domain_specials } from '@/lib/auth/constants';
import { createOrUpdateUser, type CreateOrUpdateUserArgs } from '@/lib/user';
import { generateApiToken } from '@/lib/tokens';

// Bad/expired ID tokens are a 401; JWKS-fetch or network failures during verification are
// server faults and must surface as 500, not be misreported as an invalid token.
function isInvalidNativeTokenError(error: unknown): boolean {
  return error instanceof NativeIdTokenError || error instanceof AppleJwtClientError;
}

const requestSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('apple'),
    idToken: z.string(),
    fullName: z.string().optional(),
  }),
  z.object({
    provider: z.literal('google'),
    idToken: z.string(),
  }),
  z.object({
    provider: z.literal('email'),
    email: z.string().email(),
    code: z.string(),
  }),
]);

/**
 * Native (mobile) sign-in token exchange. Verifies an Apple/Google ID token or an
 * email sign-in code, creates or updates the user, and mints the same API token
 * shape as the device-auth poll endpoint.
 *
 * Response contract (frozen — mobile client is built against it):
 *   200 { token }
 *   401 { error: 'INVALID_TOKEN' }        — bad apple/google ID token
 *   401 { error: 'INVALID_CODE' }         — bad email sign-in code
 *   429 { error: 'TOO_MANY_ATTEMPTS' }    — email code attempt budget exhausted
 *   403 { error: AuthErrorType }          — createOrUpdateUser rejected the sign-in
 *   400                                   — invalid request body
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const validation = requestSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const data = validation.data;
  let args: CreateOrUpdateUserArgs;
  let autoLinkToExistingUser: boolean;

  if (data.provider === 'apple') {
    let verified;
    try {
      verified = await verifyNativeAppleIdToken(data.idToken);
    } catch (error) {
      if (!isInvalidNativeTokenError(error)) {
        throw error;
      }
      return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 401 });
    }

    args = {
      google_user_email: verified.email,
      google_user_name: data.fullName ?? verified.email.split('@')[0],
      google_user_image_url: '',
      hosted_domain: hosted_domain_specials.apple,
      provider: 'apple',
      provider_account_id: verified.sub,
      display_name: null,
    };
    autoLinkToExistingUser = false;
  } else if (data.provider === 'google') {
    let verified;
    try {
      verified = await verifyNativeGoogleIdToken(data.idToken);
    } catch (error) {
      if (!isInvalidNativeTokenError(error)) {
        throw error;
      }
      return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 401 });
    }

    args = {
      google_user_email: verified.email,
      google_user_name: verified.name || '',
      google_user_image_url: verified.picture || '',
      hosted_domain: verified.hd ?? hosted_domain_specials.non_workspace_google_account,
      provider: 'google',
      provider_account_id: verified.sub,
      display_name: null,
    };
    autoLinkToExistingUser = false;
  } else {
    const codeResult = await verifyAndConsumeSignInCode(data.email, data.code);
    if (codeResult === 'invalid') {
      return NextResponse.json({ error: 'INVALID_CODE' }, { status: 401 });
    }
    if (codeResult === 'too_many_attempts') {
      return NextResponse.json({ error: 'TOO_MANY_ATTEMPTS' }, { status: 429 });
    }

    const emailDomain = data.email.split('@')[1];
    args = {
      google_user_email: data.email,
      google_user_name: data.email.split('@')[0],
      google_user_image_url: '',
      hosted_domain: emailDomain || hosted_domain_specials.email,
      provider: 'email',
      provider_account_id: data.email,
      display_name: null,
    };
    autoLinkToExistingUser = true;
  }

  const result = await createOrUpdateUser(args, undefined, autoLinkToExistingUser, request.headers);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 403 });
  }

  const token = generateApiToken(result.user);
  return NextResponse.json({ token }, { status: 200 });
}
