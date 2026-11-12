import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';

import {
  createRegistrationOptions,
  verifyRegistration,
  PasskeyVerificationError,
} from '@/lib/auth/passkey';
import { checkFirewallRateLimit } from '@/lib/auth/firewall-rate-limit';
import { registrationResponseSchema } from '@/lib/auth/passkey-response';
import { getUserFromSessionForCredentialIssuance } from '@kilocode/web-shared/lib/user/server';
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
 * `PasskeyVerificationError` code on refusal, 429 when the account exceeds the
 * registration-options firewall rule, 503 `RATE_LIMIT_UNAVAILABLE` when the
 * firewall check cannot be evaluated.
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
 * Admins may only enroll another sign-in factor when this browser session is
 * fresh: a live step-up proof is sufficient, and a first passkey (which cannot
 * have a proof yet) requires a primary sign-in from the last ten minutes.
 *
 * This applies to every admin, not behind a release toggle: a stolen admin
 * cookie must not be enough to add a durable sign-in factor. Non-admins are
 * unaffected.
 */
async function refuseStaleAdminEnrollment(params: {
  user: { id: string; is_admin: boolean };
  webSessionId?: string;
  authenticatedAt?: number;
}): Promise<NextResponse | null> {
  if (!params.user.is_admin) return null;

  if (
    typeof params.authenticatedAt === 'number' &&
    Date.now() - params.authenticatedAt * 1000 <= STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS
  ) {
    return null;
  }

  if (params.webSessionId) {
    try {
      const evaluation = await evaluateStepUp({
        userId: params.user.id,
        webSessionId: params.webSessionId,
        actionClass: 'platform_read',
      });
      if (evaluation.state.status === 'fresh') return null;
    } catch (error) {
      // The freshness rule is a security control, so an unknown answer fails
      // closed for this request. The original Drizzle error is not reported.
      reportStepUpFailure('admin_passkey_enrollment', error);
      return NextResponse.json({ error: 'STEP_UP_UNAVAILABLE' }, { status: 503 });
    }
  }

  return NextResponse.json({ error: 'REAUTH_REQUIRED' }, { status: 401 });
}

export async function POST(request: NextRequest) {
  // Enrollment and management are session-only: a bearer token must not be
  // able to add a sign-in factor to the account.
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
      if (limit === 'limited') {
        return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
      }
      if (limit === 'unavailable') {
        return NextResponse.json({ error: 'RATE_LIMIT_UNAVAILABLE' }, { status: 503 });
      }

      const reauth = await refuseStaleAdminEnrollment({
        user,
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

    const reauth = await refuseStaleAdminEnrollment({
      user,
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

    if (user.is_admin) {
      try {
        await recordAdminAction(
          {
            user: {
              id: user.id,
              google_user_email: user.google_user_email,
              google_user_name: user.google_user_name,
              is_super_admin: user.is_super_admin,
            },
            authViaToken: false,
            credential: 'session',
            headersList: request.headers,
            trpcPath: '/api/auth/passkey/register',
          },
          {
            action: 'admin.passkey.enrolled',
            target: { type: 'user', id: user.id },
            message: 'Enrolled a passkey for a platform admin',
          }
        );
      } catch (error) {
        // The credential is already registered; report the audit gap without
        // telling the user their enrollment failed.
        captureException(error, { tags: { source: 'admin_passkey_enrollment_audit' } });
      }
    }

    return NextResponse.json({ credentialId: credential.credential_id });
  } catch (error) {
    if (error instanceof PasskeyVerificationError) {
      return NextResponse.json({ error: error.code }, { status: 401 });
    }
    throw error;
  }
}
