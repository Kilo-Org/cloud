import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import {
  verifyNativeAppleIdToken,
  verifyNativeGoogleIdToken,
  exchangeNativeGoogleAuthCode,
  NativeIdTokenError,
} from '@/lib/auth/native-id-tokens';
import { AppleJwtClientError } from '@/lib/auth/apple-jwks';
import {
  reserveSignInCode,
  commitSignInCode,
  releaseSignInCode,
  consumeSignInCode,
} from '@/lib/auth/magic-link-tokens';
import { hosted_domain_specials } from '@/lib/auth/constants';
import {
  createOrUpdateUser,
  findUserById,
  findUserByNormalizedEmail,
  findUserIdByAuthProvider,
  type CreateOrUpdateUserArgs,
} from '@/lib/user';
import { generateApiToken } from '@/lib/tokens';
import { checkDomainSignInEligibility } from '@/lib/auth/email-signin-eligibility';
import { checkNativeAdmission } from '@/lib/auth/native-admission';
import { createDeviceSession, issueSessionCredentials } from '@/lib/auth/device-sessions';
import { captureMessage } from '@sentry/nextjs';
import PostHogClient from '@/lib/posthog';

const posthogClient = PostHogClient();

// Bad/expired ID tokens are a 401; JWKS-fetch or network failures during verification are
// server faults and must surface as 500, not be misreported as an invalid token.
function isInvalidNativeTokenError(error: unknown): boolean {
  return error instanceof NativeIdTokenError || error instanceof AppleJwtClientError;
}

function eligibilityResponse(
  eligibility: Exclude<Awaited<ReturnType<typeof checkDomainSignInEligibility>>, { ok: true }>
) {
  return NextResponse.json(
    {
      error: eligibility.errorCode,
      ...(eligibility.ssoOrganizationId
        ? { ssoOrganizationId: eligibility.ssoOrganizationId }
        : {}),
    },
    { status: eligibility.status }
  );
}

async function checkExistingProviderAccount(
  provider: 'apple' | 'google',
  providerAccountId: string
) {
  const userId = await findUserIdByAuthProvider(provider, providerAccountId);
  if (!userId) {
    return undefined;
  }
  const user = await findUserById(userId);
  if (!user) {
    throw new Error(`Auth provider references missing user ${userId}`);
  }
  if (user.blocked_reason) {
    return NextResponse.json({ error: 'BLOCKED' }, { status: 403 });
  }
  const eligibility = await checkDomainSignInEligibility(user.google_user_email);
  return eligibility.ok ? undefined : eligibilityResponse(eligibility);
}

const requestSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('apple'),
    idToken: z.string(),
    fullName: z.string().optional(),
    nonce: z.string().optional(),
    supportsRefresh: z.boolean().optional(),
    admission: z.unknown().optional(),
  }),
  z.object({
    provider: z.literal('google'),
    idToken: z.string().optional(),
    serverAuthCode: z.string().optional(),
    googleClientId: z.string().optional(),
    supportsRefresh: z.boolean().optional(),
    admission: z.unknown().optional(),
  }),
  z.object({
    provider: z.literal('email'),
    email: z.string().email(),
    code: z.string(),
    challengeId: z.string().uuid().optional(),
    supportsRefresh: z.boolean().optional(),
    admission: z.unknown().optional(),
  }),
]);

/**
 * Native (mobile) sign-in token exchange. Verifies an Apple/Google ID token or an
 * email sign-in code, creates or updates the user, and mints an API token.
 *
 * Response contract (frozen — mobile client is built against it):
 *   200 { token, refreshToken?, expiresIn? }  — refreshToken+expiresIn only when
 *                                                   the client opts into refresh
 *                                                   (supportsRefresh: true)
 *   401 { error: 'INVALID_TOKEN' }        — bad apple/google ID token
 *   401 { error: 'INVALID_CODE' }         — bad email sign-in code
 *   425 { error: 'CODE_IN_PROGRESS' }     — another request is processing this code
 *   429 { error: 'TOO_MANY_ATTEMPTS' }    — email code attempt budget exhausted
 *   403/503 { error: 'BLOCKED' | 'SSO_ERROR', ssoOrganizationId? } — apple/google domain
 *                                            blacklisted or SSO-enforced (checkDomainSignInEligibility)
 *   403 { error: AuthErrorType }          — createOrUpdateUser rejected the sign-in
 *   403 { error: 'ADMISSION_REQUIRED' }   — admission check failed under enforce mode
 *   400                                   — invalid request body
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => undefined);
  const validation = requestSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const data = validation.data;

  // Admission check: must run before any provider verification.
  const admission = checkNativeAdmission(body);
  if (!admission.ok) {
    return NextResponse.json({ error: admission.errorCode }, { status: 403 });
  }

  let args: CreateOrUpdateUserArgs;
  let autoLinkToExistingUser: boolean;

  if (data.provider === 'apple') {
    let verified;
    try {
      verified = await verifyNativeAppleIdToken(data.idToken, data.nonce);
    } catch (error) {
      if (!isInvalidNativeTokenError(error)) {
        throw error;
      }
      return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 401 });
    }

    const eligibility = await checkDomainSignInEligibility(verified.email);
    if (!eligibility.ok) {
      return eligibilityResponse(eligibility);
    }
    const existingAccountResponse = await checkExistingProviderAccount('apple', verified.sub);
    if (existingAccountResponse) {
      return existingAccountResponse;
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
      if (data.serverAuthCode) {
        const { GOOGLE_CLIENT_ID } = await import('@/lib/config.server');
        if (!data.googleClientId || data.googleClientId !== GOOGLE_CLIENT_ID) {
          throw new Error('Mobile Google client ID does not match the server OAuth client');
        }
        verified = await exchangeNativeGoogleAuthCode(data.serverAuthCode);
      } else if (data.idToken) {
        // ponytail: remove legacy idToken-only path after all shipped clients send
        // serverAuthCode and the legacy counter has drained.
        captureMessage('native_google_idtoken_legacy_count: 1');
        verified = await verifyNativeGoogleIdToken(data.idToken);
      } else {
        return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
      }
    } catch (error) {
      if (!isInvalidNativeTokenError(error)) {
        throw error;
      }
      return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 401 });
    }

    const eligibility = await checkDomainSignInEligibility(verified.email);
    if (!eligibility.ok) {
      return eligibilityResponse(eligibility);
    }
    const existingAccountResponse = await checkExistingProviderAccount('google', verified.sub);
    if (existingAccountResponse) {
      return existingAccountResponse;
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
    // Email sign-in code path: reserve → settle → commit.
    // A failed settlement must release the reservation so the code stays usable.
    const existingUser = await findUserByNormalizedEmail(data.email);
    const email = existingUser?.google_user_email ?? data.email.toLowerCase();

    const reserveResult = await reserveSignInCode(data.email, data.code, data.challengeId);
    if (reserveResult === 'invalid') {
      return NextResponse.json({ error: 'INVALID_CODE' }, { status: 401 });
    }
    if (reserveResult === 'too_many_attempts') {
      return NextResponse.json({ error: 'TOO_MANY_ATTEMPTS' }, { status: 429 });
    }
    if (reserveResult === 'in_progress') {
      return NextResponse.json({ error: 'CODE_IN_PROGRESS' }, { status: 425 });
    }

    let phase: 'reserved' | 'release' | 'committed' = 'reserved';

    try {
      const eligibility = await checkDomainSignInEligibility(email);
      if (!eligibility.ok) {
        phase = 'release';
        return eligibilityResponse(eligibility);
      }

      const emailDomain = email.split('@')[1];
      args = {
        google_user_email: email,
        google_user_name: email.split('@')[0],
        google_user_image_url: '',
        hosted_domain: emailDomain || hosted_domain_specials.email,
        provider: 'email',
        provider_account_id: email,
        display_name: null,
      };
      autoLinkToExistingUser = true;

      // createOrUpdateUser is idempotent for existing users:
      // findAndSyncExistingUser returns the existing row and isNew: false.
      const result = await createOrUpdateUser(
        args,
        undefined,
        autoLinkToExistingUser,
        request.headers,
        undefined,
        undefined,
        true
      );
      if (!result.success) {
        phase = 'release';
        return NextResponse.json({ error: result.error }, { status: 403 });
      }

      if (result.user.blocked_reason) {
        phase = 'release';
        return NextResponse.json({ error: 'BLOCKED' }, { status: 403 });
      }

      const resolvedEligibility = await checkDomainSignInEligibility(result.user.google_user_email);
      if (!resolvedEligibility.ok) {
        phase = 'release';
        return eligibilityResponse(resolvedEligibility);
      }

      // Consume the code BEFORE issuing any credential.
      // If the reservation lapsed (commit returns false), the user is legitimately
      // settled — consume the code unconditionally and log the lapse window.
      const committed = await commitSignInCode(data.email, data.code, data.challengeId);
      if (!committed) {
        // Unconditional consume: set consumed_at even without a live reservation
        // so this code cannot settle again and create a second session.
        const consumed = await consumeSignInCode(data.email, data.code, data.challengeId);
        if (!consumed) {
          // Another request already consumed the code — do NOT issue credentials.
          return NextResponse.json({ error: 'INVALID_CODE' }, { status: 401 });
        }
        captureMessage('native_token_code_reservation_lapsed');
      }
      phase = 'committed';

      // Emit deferred sign-in analytics after all gates pass.
      if (result.deferredSignInEvent) {
        posthogClient.capture(result.deferredSignInEvent);
      }

      // Only now issue credentials — consumption is confirmed.
      // ponytail: remove legacy long-lived path after all shipped clients have
      // refreshed their token at least once and the legacy counter has drained.
      if (data.supportsRefresh) {
        const sessionId = await createDeviceSession({
          userId: result.user.id,
          userAgent: request.headers.get('user-agent') ?? undefined,
        });
        const pair = await issueSessionCredentials(result.user, sessionId);
        return NextResponse.json(
          { token: pair.token, refreshToken: pair.refreshToken, expiresIn: pair.expiresIn },
          { status: 200 }
        );
      }

      captureMessage('native_token_legacy_long_lived_count: 1');
      const token = generateApiToken(result.user);
      return NextResponse.json({ token }, { status: 200 });
    } catch (error) {
      phase = 'release';
      throw error;
    } finally {
      if (phase === 'release') {
        await releaseSignInCode(data.email, data.code, data.challengeId);
      }
    }
  }

  // Apple/Google path: settlement without reservation (no code to release).
  const result = await createOrUpdateUser(
    args,
    undefined,
    autoLinkToExistingUser,
    request.headers,
    undefined,
    undefined,
    true
  );
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 403 });
  }

  if (result.user.blocked_reason) {
    return NextResponse.json({ error: 'BLOCKED' }, { status: 403 });
  }

  const resolvedEligibility = await checkDomainSignInEligibility(result.user.google_user_email);
  if (!resolvedEligibility.ok) {
    return eligibilityResponse(resolvedEligibility);
  }

  // Emit deferred sign-in analytics after all gates pass.
  if (result.deferredSignInEvent) {
    posthogClient.capture(result.deferredSignInEvent);
  }

  // ponytail: remove legacy long-lived path after all shipped clients have
  // refreshed their token at least once and the legacy counter has drained.
  if (data.supportsRefresh) {
    const sessionId = await createDeviceSession({
      userId: result.user.id,
      userAgent: request.headers.get('user-agent') ?? undefined,
    });
    const pair = await issueSessionCredentials(result.user, sessionId);
    return NextResponse.json(
      { token: pair.token, refreshToken: pair.refreshToken, expiresIn: pair.expiresIn },
      { status: 200 }
    );
  }

  captureMessage('native_token_legacy_long_lived_count: 1');
  const token = generateApiToken(result.user);
  return NextResponse.json({ token }, { status: 200 });
}
