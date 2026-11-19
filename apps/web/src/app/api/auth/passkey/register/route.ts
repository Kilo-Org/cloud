import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import type { User } from '@kilocode/db/schema';

import {
  createRegistrationOptions,
  verifyNativeRegistration,
  verifyRegistration,
  PasskeyVerificationError,
} from '@/lib/auth/passkey';
import {
  bindPasskeyManagementChallenge,
  consumePasskeyManagementAuthorization,
  validatePasskeyManagementAuthorization,
} from '@/lib/auth/passkey-management';
import { checkFirewallRateLimit, firewallRateLimitRefusal } from '@/lib/auth/firewall-rate-limit';
import { registrationResponseSchema } from '@/lib/auth/passkey-response';
import {
  getUserFromAuth,
  getUserFromSessionForCredentialIssuance,
} from '@kilocode/web-shared/lib/user/server';
import { evaluateStepUp } from '@kilocode/web-shared/lib/admin/step-up-store';
import { STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS } from '@kilocode/web-shared/lib/admin/step-up-policy';
import { reportStepUpFailure } from '@kilocode/web-shared/lib/admin/step-up-observation';
import { recordAdminAction } from '@/lib/admin/admin-action-audit';
import { captureException } from '@sentry/nextjs';

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
 * `PasskeyVerificationError` code on refusal, 401 `REAUTH_REQUIRED` when this
 * session is not fresh enough to enroll, 429 when the account exceeds the
 * registration-options firewall rule, 503 `RATE_LIMIT_UNAVAILABLE` or
 * `STEP_UP_UNAVAILABLE` when the firewall or the freshness lookup cannot be
 * evaluated.
 *
 * A browser session answers as before. A request that carries a bearer token
 * is the native app path and follows the management contract below.
 */
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('options') }),
  z.object({
    action: z.literal('verify'),
    challengeId: z.string().uuid(),
    response: registrationResponseSchema,
  }),
]);

/**
 * The native app presents the single-use management grant minted by
 * `/api/auth/passkey/management/authorize` on BOTH steps. Options binds the
 * challenge it mints to that grant; verify must present the same pair and the
 * grant is redeemed inside the insertion transaction.
 *
 * The grant is optional in the schema so a native call that omits it answers
 * `PASSKEY_MANAGEMENT_REQUIRED`, the code the app turns into its verify step,
 * instead of a generic invalid-request refusal.
 */
const nativeRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('options'),
    managementAuthorization: z.string().max(512).optional(),
  }),
  z.object({
    action: z.literal('verify'),
    challengeId: z.string().uuid(),
    response: registrationResponseSchema,
    managementAuthorization: z.string().max(512).optional(),
  }),
]);

/**
 * Enrollment requires a fresh session. A primary sign-in from the last ten
 * minutes is enough for every account. A live step-up proof for this browser
 * session is accepted as well, which is how an account that can mint one — the
 * MFA ceremony, which is a platform-admin surface — enrolls without signing in
 * again; every other account satisfies the rule by signing in.
 *
 * The rule applies to every account and is not behind a release toggle.
 */
async function refuseStaleEnrollment(params: {
  userId: string;
  webSessionId?: string;
  authenticatedAt?: number;
}): Promise<NextResponse | null> {
  if (
    typeof params.authenticatedAt === 'number' &&
    Date.now() - params.authenticatedAt * 1000 <= STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS
  ) {
    return null;
  }

  if (params.webSessionId) {
    try {
      const evaluation = await evaluateStepUp({
        userId: params.userId,
        webSessionId: params.webSessionId,
        actionClass: 'platform_read',
      });
      if (evaluation.state.status === 'fresh') return null;
    } catch (error) {
      // The freshness rule is a security control, so an unknown answer fails
      // closed for this request. The original Drizzle error is not reported.
      reportStepUpFailure('passkey_enrollment', error);
      return NextResponse.json({ error: 'STEP_UP_UNAVAILABLE' }, { status: 503 });
    }
  }

  return NextResponse.json({ error: 'REAUTH_REQUIRED' }, { status: 401 });
}

/**
 * Enrolling a passkey changes which authenticators can sign in as a platform
 * admin, so the enrollment is audited whichever surface performed it. The
 * credential is already stored, so an audit failure is reported rather than
 * turning the enrollment into an error the client retries against a consumed
 * challenge.
 */
async function recordAdminPasskeyEnrollment(params: {
  user: User;
  credential: 'session' | 'human_bearer';
  authViaToken: boolean;
  headersList: Headers;
}): Promise<void> {
  if (!params.user.is_admin) return;
  try {
    await recordAdminAction(
      {
        user: {
          id: params.user.id,
          google_user_email: params.user.google_user_email,
          google_user_name: params.user.google_user_name,
          is_super_admin: params.user.is_super_admin,
        },
        authViaToken: params.authViaToken,
        credential: params.credential,
        headersList: params.headersList,
        trpcPath: '/api/auth/passkey/register',
      },
      {
        action: 'admin.passkey.enrolled',
        target: { type: 'user', id: params.user.id },
        message: 'Enrolled a passkey for a platform admin',
      }
    );
  } catch (error) {
    captureException(error, { tags: { source: 'admin_passkey_enrollment_audit' } });
  }
}

function managementAuthorizationInvalid(): NextResponse {
  return NextResponse.json({ error: 'PASSKEY_MANAGEMENT_AUTHORIZATION_INVALID' }, { status: 401 });
}

/**
 * Native app enrollment. The bearer must be a live native app session and the
 * body must carry a management grant minted from a fresh primary proof for
 * this account. The bearer alone never adds a sign-in factor, including when
 * it belongs to a platform admin.
 */
async function handleNativeRegistration(request: NextRequest): Promise<NextResponse> {
  const auth = await getUserFromAuth({
    adminOnly: false,
    requestHeaders: request.headers,
    requestPathname: '/api/auth/passkey/register',
  });
  if (auth.authFailedResponse) {
    return auth.authFailedResponse;
  }
  if (!auth.user) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  if (auth.credential !== 'human_bearer' || !auth.deviceSessionId) {
    return NextResponse.json({ error: 'PASSKEY_MANAGEMENT_DEVICE_UNSUPPORTED' }, { status: 403 });
  }
  const { user } = auth;
  const deviceSessionId = auth.deviceSessionId;

  const body = await request.json().catch(() => undefined);
  const parsed = nativeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }
  const input = parsed.data;
  const authorization = input.managementAuthorization?.trim();
  if (!authorization) {
    return NextResponse.json({ error: 'PASSKEY_MANAGEMENT_REQUIRED' }, { status: 403 });
  }
  const grant = {
    token: authorization,
    userId: user.id,
    deviceSessionId,
    operation: 'enroll' as const,
  };

  try {
    if (input.action === 'options') {
      const limit = await checkFirewallRateLimit(REGISTRATION_OPTIONS_RATE_LIMIT_ID, {
        source: 'passkey_register_options',
        request,
        rateLimitKey: registrationRateLimitKey(user.id),
      });
      const refusal = firewallRateLimitRefusal(limit);
      if (refusal) return refusal;

      // A cancelled or failed ceremony can mint options again with the same
      // grant until it expires: this step consumes nothing.
      if (!(await validatePasskeyManagementAuthorization(grant))) {
        return managementAuthorizationInvalid();
      }

      const { challengeId, options } = await createRegistrationOptions(
        user.id,
        user.google_user_email
      );

      // The challenge and the grant are one pair from here on: a challenge
      // minted under one grant cannot be verified with another.
      if (!(await bindPasskeyManagementChallenge({ ...grant, challengeId }))) {
        return managementAuthorizationInvalid();
      }

      return NextResponse.json({ challengeId, options });
    }

    const narrowedGrant = { ...grant, challengeId: input.challengeId };
    if (!(await validatePasskeyManagementAuthorization(narrowedGrant))) {
      return managementAuthorizationInvalid();
    }

    // The grant is redeemed inside the transaction that inserts the credential,
    // so a failed verify, a refused attribution, or a rolled-back insert leaves
    // it unspent and the client can retry within its lifetime.
    const credential = await verifyNativeRegistration(
      user.id,
      input.challengeId,
      input.response,
      tx => consumePasskeyManagementAuthorization({ ...narrowedGrant, fromDb: tx })
    );

    await recordAdminPasskeyEnrollment({
      user,
      credential: 'human_bearer',
      authViaToken: true,
      headersList: request.headers,
    });

    return NextResponse.json({ credentialId: credential.credential_id });
  } catch (error) {
    if (error instanceof PasskeyVerificationError) {
      return NextResponse.json({ error: error.code }, { status: 401 });
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  // A bearer token is the native app. Enrollment and management there are
  // bound to a management grant; this route never accepts a bearer on the
  // browser path.
  if (request.headers.has('authorization')) {
    return handleNativeRegistration(request);
  }

  // Browser enrollment. A passkey is a sign-in factor, so the session must be
  // fresh and a bearer token never takes this path: see the native handler.
  const { user, authFailedResponse, webSessionId, webSessionPepper, authenticatedAt } =
    await getUserFromSessionForCredentialIssuance();
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
      const refusal = firewallRateLimitRefusal(limit);
      if (refusal) return refusal;

      const reauth = await refuseStaleEnrollment({
        userId: user.id,
        webSessionId,
        authenticatedAt,
      });
      if (reauth) return reauth;

      const { challengeId, options } = await createRegistrationOptions(
        user.id,
        user.google_user_email
      );
      return NextResponse.json({ challengeId, options });
    }

    const reauth = await refuseStaleEnrollment({
      userId: user.id,
      webSessionId,
      authenticatedAt,
    });
    if (reauth) return reauth;

    const credential = await verifyRegistration(
      user.id,
      parsed.data.challengeId,
      parsed.data.response,
      webSessionPepper
    );

    await recordAdminPasskeyEnrollment({
      user,
      credential: 'session',
      authViaToken: false,
      headersList: request.headers,
    });

    return NextResponse.json({ credentialId: credential.credential_id });
  } catch (error) {
    if (error instanceof PasskeyVerificationError) {
      return NextResponse.json({ error: error.code }, { status: 401 });
    }
    throw error;
  }
}
