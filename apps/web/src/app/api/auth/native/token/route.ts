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
} from '@kilocode/web-shared/lib/auth/magic-link-tokens';
import { hosted_domain_specials } from '@kilocode/web-shared/lib/auth/constants';
import { consumeSignInTicket } from '@/lib/auth/passkey';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import {
  createOrUpdateUser,
  findUserByNormalizedEmail,
  findUserIdByAuthProvider,
  type CreateOrUpdateUserArgs,
  type CreateOrUpdateUserResult,
} from '@/lib/user';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import { checkDomainSignInEligibility } from '@/lib/auth/email-signin-eligibility';
import {
  requireAdmissionPayload,
  countAdmissionCondition,
  verifyAdmissionAsync,
  persistAttestedKey,
  KeyCollisionError,
  type VerifyAdmissionOk,
} from '@/lib/auth/native-admission';
import {
  createDeviceSession,
  issueSessionCredentials,
  createDeviceSessionWithAttestedKey,
} from '@/lib/auth/device-sessions';
import { captureMessage } from '@sentry/nextjs';
import PostHogClient from '@kilocode/web-shared/lib/posthog';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

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

/**
 * A refused user settlement. An unavailable signup is retryable (503); a step-up names the
 * sign-in methods that can finish the signup.
 */
function settlementFailureResponse(failure: Extract<CreateOrUpdateUserResult, { success: false }>) {
  if (failure.error === 'SIGNUP-STEP-UP') {
    return NextResponse.json({ error: failure.error, methods: failure.methods }, { status: 403 });
  }
  return NextResponse.json(
    { error: failure.error },
    { status: failure.error === 'SIGNUP-UNAVAILABLE' ? 503 : 403 }
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
  z.object({
    // A passkey ticket is minted by the passkey authenticate route after the
    // WebAuthn assertion verified server-side; it is redeemed exactly once.
    provider: z.literal('passkey'),
    ticket: z.string(),
    supportsRefresh: z.boolean().optional(),
  }),
]);

/**
 * Native (mobile) sign-in token exchange. Verifies an Apple/Google ID token, an
 * email sign-in code, or a passkey sign-in ticket, creates or updates the user,
 * and mints an API token.
 *
 * Every request must prove the device is attested. The order is:
 *   1. Admission gate: a missing or malformed proof is refused with 403.
 *   2. Admission verification: the App Attest or Play Integrity proof is
 *      verified before any provider call, OTP reservation, ticket consumption,
 *      or user settlement, so a refusal precedes every side effect.
 *   3. Provider identity verification.
 *   4. User settlement (createOrUpdateUser).
 *   5. Key persistence (after settlement, binds key to user id).
 *
 * A passkey ticket skips steps 4 and 5: the ticket is a live proof that a
 * WebAuthn assertion verified server-side, so the user exists already and no
 * account settlement or attested-key binding applies.
 *
 * Response contract (frozen — mobile client is built against it):
 *   200 { token, refreshToken?, expiresIn?, created? }
 *   401 { error: 'INVALID_TOKEN' }
 *   401 { error: 'INVALID_CODE' }
 *   401 { error: 'INVALID_TICKET' }
 *   425 { error: 'CODE_IN_PROGRESS' }
 *   429 { error: 'TOO_MANY_ATTEMPTS' }
 *   403/503 { error: 'BLOCKED' | 'SSO_ERROR', ssoOrganizationId? }
 *   403 { error: AuthErrorType }
 *   403 { error: 'ADMISSION_REQUIRED' }
 *   400 invalid request body
 *   500 admission provider or identity provider infrastructure error
 */
export const POST = withRestTiming('/api/auth/native/token', async (request: Request) => {
  const body = await request.json().catch(() => undefined);
  const validation = requestSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const data = validation.data;

  // ── Step 1: Admission gate ───────────────────────────────────────────────
  // Credentials are issued only to an attested device. A missing or malformed
  // proof is refused before any provider call, OTP reservation, ticket
  // consumption, or user settlement, so no side effect precedes the gate.
  const admissionPayload = requireAdmissionPayload(body);
  if (!admissionPayload) {
    countAdmissionCondition('native_admission_missing');
    return NextResponse.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 });
  }

  // ── Step 2: Verify the proof ─────────────────────────────────────────────
  // A refused verdict is a 403. A provider fault is retryable, so it must not
  // be reported as a refusal of the device.
  let admissionVerification: VerifyAdmissionOk;
  try {
    const verified = await verifyAdmissionAsync(admissionPayload);
    if (!verified.ok) {
      countAdmissionCondition('native_admission_refused');
      return NextResponse.json({ error: verified.errorCode }, { status: 403 });
    }
    admissionVerification = verified;
  } catch {
    captureMessage('native_admission_unavailable');
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }

  // A proof bound to a key that already belongs to an account cannot create a
  // second one. Checked before settlement so a collision never leaves a user
  // row or a Stripe customer behind.
  const verifyNewAccountAdmission = () => Promise.resolve(!admissionVerification.existingKeyUserId);

  // ── Step 3: Provider identity verification ───────────────────────────────
  let args: CreateOrUpdateUserArgs;
  let autoLinkToExistingUser: boolean;

  if (data.provider === 'passkey') {
    // The ticket is single-use and short-lived, and was minted only after a
    // WebAuthn assertion verified against a server-stored challenge, so
    // redeeming it is the identity proof. A replay consumes no row.
    const ticket = await consumeSignInTicket(data.ticket);
    if (!ticket) {
      return NextResponse.json({ error: 'INVALID_TICKET' }, { status: 401 });
    }

    const user = await findUserById(ticket.kilo_user_id);
    if (!user) {
      return NextResponse.json({ error: 'INVALID_TICKET' }, { status: 401 });
    }

    if (user.blocked_reason) {
      return NextResponse.json({ error: 'BLOCKED' }, { status: 403 });
    }

    // Same forced-SSO and blacklist gate every other native provider passes.
    const eligibility = await checkDomainSignInEligibility(user.google_user_email);
    if (!eligibility.ok) {
      return eligibilityResponse(eligibility);
    }

    // Fall into the same device-session issuance the other providers use.
    // `created` is always false: a passkey belongs to an existing user.
    if (data.supportsRefresh) {
      const sid = await createDeviceSession({
        userId: user.id,
        userAgent: request.headers.get('user-agent') ?? undefined,
      });
      const pair = await issueSessionCredentials(user, sid);
      return NextResponse.json(
        {
          token: pair.token,
          refreshToken: pair.refreshToken,
          expiresIn: pair.expiresIn,
          created: false,
        },
        { status: 200 }
      );
    }

    captureMessage('native_token_legacy_long_lived_count: 1');
    const token = generateApiToken(user);
    return NextResponse.json({ token, created: false }, { status: 200 });
  }

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
    // Verified id token enforces email_verified, so the credential proves the email.
    autoLinkToExistingUser = true;
  } else if (data.provider === 'google') {
    let verified;
    try {
      if (data.serverAuthCode) {
        const { GOOGLE_CLIENT_ID } = await import('@kilocode/web-shared/lib/config.server');
        if (!data.googleClientId || data.googleClientId !== GOOGLE_CLIENT_ID) {
          return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
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
    // Verified id token enforces email_verified, so the credential proves the email.
    autoLinkToExistingUser = true;
  } else {
    // Email sign-in code path: reserve → settle → commit.
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

      // ── Step 4: User settlement ──────────────────────────────────────
      const result = await createOrUpdateUser(
        args,
        undefined,
        autoLinkToExistingUser,
        request.headers,
        undefined,
        undefined,
        true,
        verifyNewAccountAdmission
      );
      if (!result.success) {
        phase = 'release';
        return settlementFailureResponse(result);
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

      // ── Step 4.5: Key ownership check BEFORE code commit ─────────────
      // For assertion (existing key) and attestation (keyId already bound to
      // another user): enforce → refuse without consuming the code so a
      // legitimate retry remains possible. Report → log, skip persistence,
      // and issue credentials.
      if (
        admissionVerification.existingKeyUserId &&
        admissionVerification.existingKeyUserId !== result.user.id
      ) {
        captureMessage('native_attested_key_ownership_mismatch');
        phase = 'release';
        return NextResponse.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 });
      }

      // ── Step 5: Persist attested key after settlement ─────────────────
      // Must run BEFORE code commit so a key collision does not burn the
      // sign-in code without issuing a credential.
      let sessionId: string | undefined;
      let refreshCredentials:
        | { token: string; refreshToken: string; expiresIn: number }
        | undefined;

      if (data.supportsRefresh) {
        // Bind key persistence and session creation in one transaction.
        try {
          const combined = await createDeviceSessionWithAttestedKey({
            userId: result.user.id,
            userAgent: request.headers.get('user-agent') ?? undefined,
            user: result.user,
            verification: admissionVerification,
          });
          sessionId = combined.sessionId;
          refreshCredentials = {
            token: combined.token,
            refreshToken: combined.refreshToken,
            expiresIn: combined.expiresIn,
          };
        } catch (err) {
          if (err instanceof KeyCollisionError) {
            captureMessage('native_attested_key_cross_user_collision');
            phase = 'release';
            return NextResponse.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 });
          }
          // Bookkeeping failure — log and fall through to the legacy token.
          captureMessage('native_attested_key_persist_failed_after_settlement');
        }
      } else {
        try {
          await persistAttestedKey(result.user.id, admissionVerification);
        } catch (err) {
          if (err instanceof KeyCollisionError) {
            captureMessage('native_attested_key_cross_user_collision');
            phase = 'release';
            return NextResponse.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 });
          }
          captureMessage('native_attested_key_persist_failed_after_settlement');
        }
      }

      // ── Step 6: Consume the sign-in code AFTER key persistence ─────────
      // The code is only committed once all pre-credential gates pass, so
      // a refusal never burns a code without issuing a credential.
      const committed = await commitSignInCode(data.email, data.code, data.challengeId);
      if (!committed) {
        const consumed = await consumeSignInCode(data.email, data.code, data.challengeId);
        if (!consumed) {
          return NextResponse.json({ error: 'INVALID_CODE' }, { status: 401 });
        }
        captureMessage('native_token_code_reservation_lapsed');
      }
      phase = 'committed';

      // Emit deferred sign-in analytics after all gates pass.
      if (result.deferredSignInEvent) {
        posthogClient.capture(result.deferredSignInEvent);
      }

      if (refreshCredentials) {
        return NextResponse.json(
          {
            token: refreshCredentials.token,
            refreshToken: refreshCredentials.refreshToken,
            expiresIn: refreshCredentials.expiresIn,
            created: result.isNew,
          },
          { status: 200 }
        );
      }

      if (data.supportsRefresh) {
        const sid =
          sessionId ??
          (await createDeviceSession({
            userId: result.user.id,
            userAgent: request.headers.get('user-agent') ?? undefined,
          }));
        const pair = await issueSessionCredentials(result.user, sid);
        return NextResponse.json(
          {
            token: pair.token,
            refreshToken: pair.refreshToken,
            expiresIn: pair.expiresIn,
            created: result.isNew,
          },
          { status: 200 }
        );
      }

      captureMessage('native_token_legacy_long_lived_count: 1');
      const token = generateApiToken(result.user);
      return NextResponse.json({ token, created: result.isNew }, { status: 200 });
    } catch (error) {
      phase = 'release';
      throw error;
    } finally {
      if (phase === 'release') {
        await releaseSignInCode(data.email, data.code, data.challengeId);
      }
    }
  }

  // Apple/Google path.

  // ── Step 4: User settlement ──────────────────────────────────────────────
  const result = await createOrUpdateUser(
    args,
    undefined,
    autoLinkToExistingUser,
    request.headers,
    undefined,
    undefined,
    true,
    verifyNewAccountAdmission
  );
  if (!result.success) {
    return settlementFailureResponse(result);
  }

  if (result.user.blocked_reason) {
    return NextResponse.json({ error: 'BLOCKED' }, { status: 403 });
  }

  // ── Step 5: Final eligibility check BEFORE persisting credentials ────────
  // The resolved account email can differ from the ID-token email (provider
  // account linking). Refuse before a device session, refresh token, or
  // attested key is persisted so an ineligible account leaves no credentials.
  const resolvedEligibility = await checkDomainSignInEligibility(result.user.google_user_email);
  if (!resolvedEligibility.ok) {
    return eligibilityResponse(resolvedEligibility);
  }

  // ── Step 6: Persist attested key after settlement ────────────────────────
  let sessionId: string | undefined;
  let refreshCredentials: { token: string; refreshToken: string; expiresIn: number } | undefined;

  // Cross-user ownership: a key bound to another account cannot sign this one
  // in. Refuse before any credential is issued.
  if (
    admissionVerification.existingKeyUserId &&
    admissionVerification.existingKeyUserId !== result.user.id
  ) {
    captureMessage('native_attested_key_ownership_mismatch');
    return NextResponse.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 });
  }

  if (data.supportsRefresh) {
    // Bind key persistence and session creation in one transaction.
    try {
      const combined = await createDeviceSessionWithAttestedKey({
        userId: result.user.id,
        userAgent: request.headers.get('user-agent') ?? undefined,
        user: result.user,
        verification: admissionVerification,
      });
      sessionId = combined.sessionId;
      refreshCredentials = {
        token: combined.token,
        refreshToken: combined.refreshToken,
        expiresIn: combined.expiresIn,
      };
    } catch (err) {
      if (err instanceof KeyCollisionError) {
        captureMessage('native_attested_key_cross_user_collision');
        return NextResponse.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 });
      }
      captureMessage('native_attested_key_persist_failed_after_settlement');
    }
  } else {
    try {
      await persistAttestedKey(result.user.id, admissionVerification);
    } catch (err) {
      if (err instanceof KeyCollisionError) {
        captureMessage('native_attested_key_cross_user_collision');
        return NextResponse.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 });
      }
      captureMessage('native_attested_key_persist_failed_after_settlement');
    }
  }

  // Emit deferred sign-in analytics after all gates pass.
  if (result.deferredSignInEvent) {
    posthogClient.capture(result.deferredSignInEvent);
  }

  if (refreshCredentials) {
    return NextResponse.json(
      {
        token: refreshCredentials.token,
        refreshToken: refreshCredentials.refreshToken,
        expiresIn: refreshCredentials.expiresIn,
        created: result.isNew,
      },
      { status: 200 }
    );
  }

  if (data.supportsRefresh) {
    const sid =
      sessionId ??
      (await createDeviceSession({
        userId: result.user.id,
        userAgent: request.headers.get('user-agent') ?? undefined,
      }));
    const pair = await issueSessionCredentials(result.user, sid);
    return NextResponse.json(
      {
        token: pair.token,
        refreshToken: pair.refreshToken,
        expiresIn: pair.expiresIn,
        created: result.isNew,
      },
      { status: 200 }
    );
  }

  captureMessage('native_token_legacy_long_lived_count: 1');
  const token = generateApiToken(result.user);
  return NextResponse.json({ token, created: result.isNew }, { status: 200 });
});
