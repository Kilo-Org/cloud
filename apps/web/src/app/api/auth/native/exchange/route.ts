import { NextResponse } from 'next/server';
import { captureMessage } from '@sentry/nextjs';
import {
  getUserFromBearerForCredentialExchange,
  getUserFromSessionForCredentialIssuance,
} from '@kilocode/web-shared/lib/user/server';
import {
  createDeviceSessionWithAttestedKey,
  createDeviceSessionWithCredentials,
} from '@/lib/auth/device-sessions';
import {
  requireAdmissionPayload,
  countAdmissionCondition,
  reportAttestedKeyCollision,
  verifyAdmissionAsync,
  KeyCollisionError,
  type VerifyAdmissionOk,
} from '@/lib/auth/native-admission';
import { isNativeTokenAddressRateLimited } from '@/lib/auth/native-token-rate-limit';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import {
  auditAuthRoute,
  authAuditRequestFromHeaders,
  type AuthAuditAttempt,
} from '@/lib/auth/auth-audit';

/**
 * Token exchange endpoint. Authenticates with the existing long-lived bearer
 * token, creates a device session, and returns a short-lived token pair.
 *
 * The old token is NOT invalidated. If the client crashes mid-exchange, it
 * must still be able to start over with the same long-lived token. The old
 * token dies of natural expiry.
 *
 * The device must prove it is attested before any credential is read, because
 * this endpoint mints the same mobile credentials as the sign-in exchange. A
 * verified key is bound to the authenticated user in the transaction that
 * creates the device session, so a key id the client stores always names a
 * server row. A key that belongs to another account is refused.
 *
 * The caller-address firewall limit is counted first, before the admission
 * gate and before any credential is read, and both native credential
 * endpoints count the same rule at that point, so one caller-address budget
 * covers both of them. Only a rule that answered `allowed` proceeds.
 *
 * Response contract (frozen — mobile client is built against it):
 *   200 { token, refreshToken, expiresIn }
 *   401 — invalid or expired existing token
 *   403 — blocked user
 *   403 { error: 'ADMISSION_REQUIRED' } — missing, malformed, refused, or
 *         foreign proof
 *   429 { error: 'RATE_LIMITED' } — the caller address is exchanging too fast;
 *         the admission gate has not run, the old token stays valid and the
 *         client retries on its next launch
 *   500 { error: 'INTERNAL_ERROR' } — admission provider or key-persistence
 *         infrastructure error; the old token stays valid and the client
 *         retries on its next launch
 *   500 (no JSON body) — the limiter could not be consulted and its client
 *         threw, so the framework answers rather than this handler; the old
 *         token stays valid and the client retries on its next launch
 */
export const POST = withRestTiming('/api/auth/native/exchange', async (request: Request) => {
  // One attempt per request: the success, or the refusal code the response carries.
  const attempt: AuthAuditAttempt = {
    action: 'auth.sign_in',
    method: request.headers.has('authorization') ? 'human_bearer' : 'session',
    metadata: { client: 'native', exchange: true },
  };
  return auditAuthRoute(
    authAuditRequestFromHeaders(request.headers, '/api/auth/native/exchange'),
    attempt,
    () => exchangeForDeviceSession(request, attempt)
  );
});

async function exchangeForDeviceSession(
  request: Request,
  attempt: AuthAuditAttempt
): Promise<Response> {
  // Counted first, so the admission gate and attestation verification run
  // inside the caller's address budget. Both native credential endpoints
  // count this rule at this point. Only a rule that answered `allowed`
  // proceeds: a rule that is not configured refuses here.
  if (await isNativeTokenAddressRateLimited(request)) {
    return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
  }

  const body = await request.json().catch(() => undefined);
  const admissionPayload = requireAdmissionPayload(
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  );
  if (!admissionPayload) {
    countAdmissionCondition('native_admission_missing');
    return NextResponse.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 });
  }

  let verification: VerifyAdmissionOk;
  try {
    const verified = await verifyAdmissionAsync(admissionPayload);
    if (!verified.ok) {
      countAdmissionCondition('native_admission_refused');
      return NextResponse.json({ error: verified.errorCode }, { status: 403 });
    }
    verification = verified;
  } catch {
    captureMessage('native_admission_unavailable');
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }

  const auth = request.headers.has('authorization')
    ? await getUserFromBearerForCredentialExchange(request.headers, { legacy: 'five-year-api' })
    : await getSessionAuth(request);

  if (auth.authFailedResponse) {
    return auth.authFailedResponse;
  }

  if (!auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  attempt.userId = auth.user.id;
  attempt.email = auth.user.google_user_email;

  const userAgent = request.headers.get('user-agent') ?? undefined;

  // A key bound to another account cannot mint credentials for this one. The
  // token route refuses at the same point, so an exchange cannot become an
  // attribution bypass.
  if (verification.existingKeyUserId && verification.existingKeyUserId !== auth.user.id) {
    captureMessage('native_attested_key_ownership_mismatch');
    countAdmissionCondition('native_admission_refused');
    return NextResponse.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 });
  }

  // Android verification and the non-production sentinel carry no key id, so
  // they persist nothing and take the plain session path.
  if (verification.keyId !== undefined) {
    try {
      const combined = await createDeviceSessionWithAttestedKey({
        userAgent,
        user: auth.user,
        verification,
      });
      return NextResponse.json(
        {
          token: combined.token,
          refreshToken: combined.refreshToken,
          expiresIn: combined.expiresIn,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    } catch (error) {
      if (error instanceof KeyCollisionError) {
        reportAttestedKeyCollision();
        return NextResponse.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 });
      }
      // Without the key row the client would hold an id the server cannot
      // assert. The long-lived token stays valid, so refuse and retry later.
      captureMessage('native_attested_key_persist_failed_during_exchange');
      return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
    }
  }

  const credentials = await createDeviceSessionWithCredentials({
    userId: auth.user.id,
    userAgent,
    user: auth.user,
  });

  return NextResponse.json(
    {
      token: credentials.token,
      refreshToken: credentials.refreshToken,
      expiresIn: credentials.expiresIn,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}

async function getSessionAuth(request: Request) {
  const origin = request.headers.get('origin');
  if (origin !== new URL(APP_URL).origin) {
    return {
      user: null,
      authFailedResponse: NextResponse.json({ error: 'Invalid origin' }, { status: 403 }),
    };
  }

  return getUserFromSessionForCredentialIssuance();
}
