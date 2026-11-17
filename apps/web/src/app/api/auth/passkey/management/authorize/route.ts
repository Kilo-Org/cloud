import { NextResponse } from 'next/server';
import * as z from 'zod';

import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import {
  commitSignInCode,
  releaseSignInCode,
  reserveSignInCode,
} from '@kilocode/web-shared/lib/auth/magic-link-tokens';
import { captureMessage } from '@sentry/nextjs';
import { findUserBySignInCodeEmail } from '@/lib/user';
import { consumeSignInTicket } from '@/lib/auth/passkey';
import { checkDomainSignInEligibility } from '@/lib/auth/email-signin-eligibility';
import {
  countAdmissionCondition,
  requireAdmissionPayload,
  verifyAdmissionAsync,
} from '@/lib/auth/native-admission';
import {
  discardPasskeyManagementAuthorization,
  hasActiveNativeDeviceSession,
  mintPasskeyManagementAuthorization,
  type MintedPasskeyManagementAuthorization,
} from '@/lib/auth/passkey-management';

const AUTHORIZE_PATH = '/api/auth/passkey/management/authorize';

const operationSchema = z.enum(['enroll', 'rename', 'remove']);

/**
 * The primary proof behind one management grant. Both proofs are existing
 * native sign-in factors: a passkey assertion ticket minted by the passkey
 * ceremony, or an email sign-in code. Neither mints a session here; the code
 * or ticket is redeemed exactly once and only into a grant.
 */
const requestSchema = z.discriminatedUnion('proof', [
  z.object({
    proof: z.literal('email'),
    operation: operationSchema,
    email: z.string().email(),
    code: z.string().min(1).max(64),
    challengeId: z.string().uuid().optional(),
    admission: z.unknown().optional(),
  }),
  z.object({
    proof: z.literal('passkey'),
    operation: operationSchema,
    ticket: z.string().min(1).max(512),
    admission: z.unknown().optional(),
  }),
]);

/**
 * Mint a short-lived, single-use grant that lets one native app session add,
 * rename, or remove a passkey.
 *
 * The caller's bearer must be a live native app session (not an ordinary API
 * key, a CLI device-auth session, or any delegated credential), and the body
 * must carry a fresh primary proof that resolves to the same account. The
 * response is the grant only: this route never issues an access token, refresh
 * token, or device session.
 *
 * Error contract: 400 invalid request, 401 UNAUTHORIZED for a rejected bearer,
 * 401 INVALID_CODE / INVALID_TICKET for a refused primary proof (retry with a
 * new one), 403 PASSKEY_MANAGEMENT_DEVICE_UNSUPPORTED for a credential that
 * may never manage passkeys, 403 ADMISSION_REQUIRED for a missing or refused
 * device proof, 403/503 from the account's SSO/domain eligibility, 425
 * CODE_IN_PROGRESS, 429 TOO_MANY_ATTEMPTS, and 500 INTERNAL_ERROR for a
 * provider fault that is worth retrying.
 */
export const POST = withRestTiming(AUTHORIZE_PATH, async (request: Request) => {
  const auth = await getUserFromAuth({
    adminOnly: false,
    requestHeaders: request.headers,
    requestPathname: AUTHORIZE_PATH,
  });
  if (auth.authFailedResponse) {
    return auth.authFailedResponse;
  }
  if (!auth.user) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  // A cookie session is the browser's own path and a bearer without a device
  // session is an ordinary API key: neither may mint a management grant.
  if (auth.credential !== 'human_bearer' || !auth.deviceSessionId) {
    return NextResponse.json({ error: 'PASSKEY_MANAGEMENT_DEVICE_UNSUPPORTED' }, { status: 403 });
  }

  // Read the session on the primary: a revocation written elsewhere must
  // refuse this request, and a CLI device-auth session may not manage passkeys.
  const sessionActive = await hasActiveNativeDeviceSession({
    deviceSessionId: auth.deviceSessionId,
    userId: auth.user.id,
  });
  if (!sessionActive) {
    return NextResponse.json({ error: 'PASSKEY_MANAGEMENT_DEVICE_UNSUPPORTED' }, { status: 403 });
  }

  const rawBody: unknown = await request.json().catch(() => undefined);
  const parsed = requestSchema.safeParse(rawBody);
  if (!parsed.success || typeof rawBody !== 'object' || rawBody === null) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }
  const data = parsed.data;

  // The device proof is verified before any code, ticket, or grant is touched,
  // so a refused device leaves no side effect behind.
  const admissionPayload = requireAdmissionPayload(rawBody as Record<string, unknown>);
  if (!admissionPayload) {
    countAdmissionCondition('native_admission_missing');
    return NextResponse.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 });
  }
  try {
    const verified = await verifyAdmissionAsync(admissionPayload);
    if (!verified.ok) {
      countAdmissionCondition('native_admission_refused');
      return NextResponse.json({ error: verified.errorCode }, { status: 403 });
    }
  } catch {
    captureMessage('native_admission_unavailable');
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }

  // The proof must resolve to the account the bearer names. The passkey ticket
  // is redeemed here exactly once; the token exchange redeeming the same
  // ticket would match no row.
  if (data.proof === 'passkey') {
    const ticket = await consumeSignInTicket(data.ticket);
    if (!ticket || ticket.kilo_user_id !== auth.user.id) {
      return NextResponse.json({ error: 'INVALID_TICKET' }, { status: 401 });
    }
  } else {
    // The account is resolved from the address the code was delivered to. A
    // code for another account is refused without reserving (and so without
    // spending an attempt on) that account's code.
    const codeUser = await findUserBySignInCodeEmail(data.email);
    if (!codeUser || codeUser.id !== auth.user.id) {
      return NextResponse.json({ error: 'INVALID_CODE' }, { status: 401 });
    }
  }

  // Identity is confirmed, so a refused domain is answered for this account
  // only. The grant is as sensitive as a sign-in, so it follows the same rule.
  const eligibility = await checkDomainSignInEligibility(auth.user.google_user_email);
  if (!eligibility.ok) {
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

  if (data.proof === 'email') {
    const reserved = await reserveSignInCode(data.email, data.code, data.challengeId);
    if (reserved === 'invalid') {
      return NextResponse.json({ error: 'INVALID_CODE' }, { status: 401 });
    }
    if (reserved === 'too_many_attempts') {
      return NextResponse.json({ error: 'TOO_MANY_ATTEMPTS' }, { status: 429 });
    }
    if (reserved === 'in_progress') {
      return NextResponse.json({ error: 'CODE_IN_PROGRESS' }, { status: 425 });
    }

    let minted: MintedPasskeyManagementAuthorization | undefined;
    try {
      minted = await mintPasskeyManagementAuthorization({
        userId: auth.user.id,
        deviceSessionId: auth.deviceSessionId,
        operation: data.operation,
      });
      const committed = await commitSignInCode(data.email, data.code, data.challengeId);
      if (!committed) {
        // The reservation lapsed before settlement: the code is spent, so the
        // grant minted from it must not survive.
        await discardPasskeyManagementAuthorization(minted.id);
        return NextResponse.json({ error: 'INVALID_CODE' }, { status: 401 });
      }

      return NextResponse.json(
        {
          authorization: minted.token,
          operation: minted.operation,
          expiresIn: minted.expiresIn,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    } catch (error) {
      // Nothing was delivered. Release the reservation (a settlement failure
      // must not cost the user an attempt) and drop any grant minted for it, so
      // a failed settlement never leaves a usable authorization behind.
      await releaseSignInCode(data.email, data.code, data.challengeId).catch(() => undefined);
      if (minted) {
        await discardPasskeyManagementAuthorization(minted.id).catch(() => undefined);
      }
      throw error;
    }
  }

  const minted = await mintPasskeyManagementAuthorization({
    userId: auth.user.id,
    deviceSessionId: auth.deviceSessionId,
    operation: data.operation,
  });

  return NextResponse.json(
    {
      authorization: minted.token,
      operation: minted.operation,
      expiresIn: minted.expiresIn,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
});
