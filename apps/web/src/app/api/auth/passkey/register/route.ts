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
  createPasskeyEnrollmentCode,
  deletePasskeyEnrollmentCode,
  expirePasskeyEnrollmentCode,
  PASSKEY_ENROLLMENT_CODE_EXPIRY_MINUTES,
  checkPasskeyEnrollmentCode,
  PasskeyEnrollmentCodeRefusedError,
  type PasskeyEnrollmentCodeRefusal,
  type PasskeyEnrollmentEmailCode,
} from '@/lib/auth/passkey-enrollment-email-code';
import { PASSKEY_ENROLLMENT_CODE_LENGTH } from '@/lib/auth/passkey-enrollment-codes';
import { sendPasskeyEnrollmentCodeEmail } from '@kilocode/web-shared/lib/email';
import {
  getUserFromAuth,
  getUserFromSessionForCredentialIssuance,
} from '@kilocode/web-shared/lib/user/server';
import { evaluateStepUp } from '@kilocode/web-shared/lib/admin/step-up-store';
import { STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS } from '@kilocode/web-shared/lib/admin/step-up-policy';
import { reportStepUpFailure } from '@kilocode/web-shared/lib/admin/step-up-observation';
import { recordAdminAction } from '@kilocode/web-shared/lib/admin/admin-action-audit';
import { captureException } from '@sentry/nextjs';
import {
  auditAuthRoute,
  authAuditRequestFromHeaders,
  type AuthAuditAttempt,
} from '@/lib/auth/auth-audit';

/**
 * Vercel Firewall rate-limit rule applied to `{ action: 'send_code' }` and
 * `{ action: 'options' }`, keyed per user because the session is the actor.
 * The rule lives in the project's firewall configuration and must be created
 * there with this exact id. When a check returns an error the branch returns
 * 503 RATE_LIMIT_UNAVAILABLE; the shared check reports that condition to
 * Sentry.
 */
const REGISTRATION_OPTIONS_RATE_LIMIT_ID = 'passkey-registration-options';

function registrationRateLimitKey(userId: string): string {
  return `passkey-register-options:${userId}`;
}

/**
 * Browser enrollment takes a fresh session and a code emailed to the account.
 * `{ action: 'send_code' }` emails a code bound to this browser session.
 * `{ action: 'options', emailCode }` checks the code without using it, then
 * mints registration options and stores the challenge server-side, so a
 * cancelled ceremony can ask again with the same code. `{ action: 'verify',
 * challengeId, response, emailCode }` verifies the attestation against that
 * stored challenge, binds the credential to the authenticated user and uses
 * the code in the same transaction.
 *
 * Error contract:
 * - 400 `INVALID_REQUEST` for a body this schema refuses.
 * - 401 `REAUTH_REQUIRED` when this session is not fresh enough to enroll or
 *   has no browser session id.
 * - 401 `EMAIL_CODE_REQUIRED` when options or verify has no `emailCode`.
 * - 401 `EMAIL_CODE_INVALID` with `attemptsLeft` for a wrong code.
 * - 401 `EMAIL_CODE_EXPIRED` for an expired, used, replaced or unknown code;
 *   the client sends a new code.
 * - 401 `{ error }` with a stable `PasskeyVerificationError` code when the
 *   ceremony is refused.
 * - 422 `EMAIL_UNDELIVERABLE` when the account's address refuses email.
 * - 429 `EMAIL_CODE_COOLDOWN` (resend too soon), `EMAIL_CODE_HOURLY_LIMIT`
 *   (the account has been sent the hourly limit of codes) or
 *   `EMAIL_CODE_LOCKED`, each with `retryAfterSeconds` and `Retry-After`, or
 *   `RATE_LIMITED` when the account exceeds the firewall rule.
 * - 502 `EMAIL_DELIVERY_FAILED` when the code email could not be sent; retry.
 * - 503 `RATE_LIMIT_UNAVAILABLE` or `STEP_UP_UNAVAILABLE` when the firewall or
 *   the freshness lookup cannot be evaluated.
 *
 * A request that carries a bearer token is the native app path and follows
 * the management contract below.
 */
const emailCodeSchema = z.object({
  emailCodeId: z.string().uuid(),
  code: z.string().regex(new RegExp(`^\\d{${PASSKEY_ENROLLMENT_CODE_LENGTH}}$`)),
});

/**
 * `emailCode` is optional in the schema so a client that omits it answers
 * `EMAIL_CODE_REQUIRED` instead of a generic invalid-request refusal.
 */
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send_code') }),
  z.object({ action: z.literal('options'), emailCode: emailCodeSchema.optional() }),
  z.object({
    action: z.literal('verify'),
    challengeId: z.string().uuid(),
    response: registrationResponseSchema,
    emailCode: emailCodeSchema.optional(),
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
async function handleNativeRegistration(
  request: NextRequest,
  attempt: AuthAuditAttempt
): Promise<NextResponse> {
  attempt.method = 'human_bearer';
  const auth = await getUserFromAuth({
    adminOnly: false,
    requestHeaders: request.headers,
    requestPathname: '/api/auth/passkey/register',
  });
  if (auth.authFailedResponse) {
    return auth.authFailedResponse;
  }
  attempt.userId = auth.user?.id ?? null;
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
  attempt.metadata = { step: input.action };
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

      // Minting options is a step of the attempt, not an added passkey.
      attempt.skipSuccessRow = true;
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

    attempt.metadata = { step: 'verify', passkeyId: credential.id };
    return NextResponse.json({ credentialId: credential.credential_id });
  } catch (error) {
    if (error instanceof PasskeyVerificationError) {
      return NextResponse.json({ error: error.code }, { status: 401 });
    }
    throw error;
  }
}

/**
 * Every request is one audited attempt. A browser `send_code` request records
 * `auth.passkey.enrollment_code.send`: the sent code, or the refusal. A
 * missing, wrong, expired or locked emailed code records
 * `auth.passkey.enrollment_code.verify` as a failure; the code is accepted as
 * part of the `auth.passkey.add` row its verify step writes. Every other
 * outcome is `auth.passkey.add`: a refusal at either step, or the verified
 * enrollment. Minting options records only a refusal.
 */
export async function POST(request: NextRequest) {
  const attempt: AuthAuditAttempt = { action: 'auth.passkey.add' };
  return auditAuthRoute(
    authAuditRequestFromHeaders(request.headers, '/api/auth/passkey/register'),
    attempt,
    () => registerPasskey(request, attempt)
  );
}

async function registerPasskey(request: NextRequest, attempt: AuthAuditAttempt): Promise<Response> {
  // A bearer token is the native app. Enrollment and management there are
  // bound to a management grant; this route never accepts a bearer on the
  // browser path.
  if (request.headers.has('authorization')) {
    return handleNativeRegistration(request, attempt);
  }

  // Browser enrollment. A passkey is a sign-in factor, so the session must be
  // fresh, the person must prove control of the account's mailbox, and a
  // bearer token never takes this path: see the native handler.
  attempt.method = 'session';
  const { user, authFailedResponse, webSessionId, webSessionPepper, authenticatedAt } =
    await getUserFromSessionForCredentialIssuance();
  if (authFailedResponse) {
    return authFailedResponse;
  }
  attempt.userId = user.id;

  const body = await request.json().catch(() => undefined);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }
  const input = parsed.data;
  attempt.metadata = { step: input.action };
  if (input.action === 'send_code') attempt.action = 'auth.passkey.enrollment_code.send';
  const refuseEmailCode = (refusal: PasskeyEnrollmentCodeRefusal): NextResponse => {
    attempt.action = 'auth.passkey.enrollment_code.verify';
    if (refusal.status === 'locked' && refusal.lockedByThisAttempt) attempt.lockout = true;
    return emailCodeRefused(refusal);
  };

  if (input.action !== 'verify') {
    const limit = await checkFirewallRateLimit(REGISTRATION_OPTIONS_RATE_LIMIT_ID, {
      source: 'passkey_register_options',
      request,
      rateLimitKey: registrationRateLimitKey(user.id),
    });
    const refusal = firewallRateLimitRefusal(limit);
    if (refusal) return refusal;
  }

  const reauth = await refuseStaleEnrollment({ userId: user.id, webSessionId, authenticatedAt });
  if (reauth) return reauth;

  // A session that signed in before browser sessions had ids can not bind a
  // code; signing in again gives it one.
  if (!webSessionId) {
    return NextResponse.json({ error: 'REAUTH_REQUIRED' }, { status: 401 });
  }
  const binding = { userId: user.id, email: user.google_user_email, webSessionId };

  if (input.action === 'send_code') {
    return sendEnrollmentCode(binding);
  }

  if (!input.emailCode) {
    attempt.action = 'auth.passkey.enrollment_code.verify';
    return NextResponse.json({ error: 'EMAIL_CODE_REQUIRED' }, { status: 401 });
  }
  const emailCode: PasskeyEnrollmentEmailCode = { binding, ...input.emailCode };

  try {
    if (input.action === 'options') {
      const checked = await checkPasskeyEnrollmentCode(emailCode);
      if (checked.status !== 'ok') return refuseEmailCode(checked);

      const { challengeId, options } = await createRegistrationOptions(
        user.id,
        user.google_user_email
      );
      attempt.skipSuccessRow = true;
      return NextResponse.json({ challengeId, options });
    }

    const credential = await verifyRegistration(
      user.id,
      input.challengeId,
      input.response,
      webSessionPepper,
      emailCode
    );

    await recordAdminPasskeyEnrollment({
      user,
      credential: 'session',
      authViaToken: false,
      headersList: request.headers,
    });

    attempt.metadata = { step: 'verify', passkeyId: credential.id };
    return NextResponse.json({ credentialId: credential.credential_id });
  } catch (error) {
    if (error instanceof PasskeyEnrollmentCodeRefusedError) {
      return refuseEmailCode(error.refusal);
    }
    if (error instanceof PasskeyVerificationError) {
      return NextResponse.json({ error: error.code }, { status: 401 });
    }
    throw error;
  }
}

function tooManyRequests(error: string, retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error, retryAfterSeconds },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
  );
}

function emailCodeRefused(refusal: PasskeyEnrollmentCodeRefusal): NextResponse {
  switch (refusal.status) {
    case 'invalid':
      return NextResponse.json(
        { error: 'EMAIL_CODE_INVALID', attemptsLeft: refusal.attemptsLeft },
        { status: 401 }
      );
    case 'expired':
      return NextResponse.json({ error: 'EMAIL_CODE_EXPIRED' }, { status: 401 });
    case 'locked':
      return tooManyRequests('EMAIL_CODE_LOCKED', refusal.retryAfterSeconds);
  }
}

/**
 * Emails a new code to the account's address. A code whose email was
 * definitely not sent is deleted. A code whose send threw is expired but kept,
 * so it still counts toward the resend cooldown and the hourly limit.
 */
async function sendEnrollmentCode(
  binding: PasskeyEnrollmentEmailCode['binding']
): Promise<NextResponse> {
  const created = await createPasskeyEnrollmentCode(binding);
  if (created.status === 'locked') {
    return tooManyRequests('EMAIL_CODE_LOCKED', created.retryAfterSeconds);
  }
  if (created.status === 'cooldown') {
    return tooManyRequests('EMAIL_CODE_COOLDOWN', created.retryAfterSeconds);
  }
  if (created.status === 'hourly_limit') {
    return tooManyRequests('EMAIL_CODE_HOURLY_LIMIT', created.retryAfterSeconds);
  }

  const delivery = await sendPasskeyEnrollmentCodeEmail(binding.email, {
    code: created.code,
    expiresInMinutes: PASSKEY_ENROLLMENT_CODE_EXPIRY_MINUTES,
  }).catch((error: unknown) => {
    captureException(error, { tags: { source: 'passkey_enrollment_code_email' } });
    return { sent: false, reason: 'send_threw' } as const;
  });

  if (!delivery.sent) {
    try {
      if (delivery.reason === 'send_threw') {
        await expirePasskeyEnrollmentCode(created.emailCodeId);
      } else {
        await deletePasskeyEnrollmentCode(created.emailCodeId);
      }
    } catch (error) {
      captureException(error, { tags: { source: 'passkey_enrollment_code_email' } });
    }
    return delivery.reason === 'neverbounce_rejected'
      ? NextResponse.json({ error: 'EMAIL_UNDELIVERABLE' }, { status: 422 })
      : NextResponse.json({ error: 'EMAIL_DELIVERY_FAILED' }, { status: 502 });
  }

  return NextResponse.json({
    emailCodeId: created.emailCodeId,
    expiresInSeconds: created.expiresInSeconds,
    email: binding.email,
  });
}
