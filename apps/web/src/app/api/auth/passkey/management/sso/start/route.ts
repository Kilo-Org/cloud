import { NextResponse } from 'next/server';
import * as z from 'zod';

import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { NEXTAUTH_URL } from '@kilocode/web-shared/lib/config.server';
import { getLowerDomainFromEmail } from '@kilocode/web-shared/lib/email-address';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import { captureMessage } from '@sentry/nextjs';

import {
  countAdmissionCondition,
  requireAdmissionPayload,
  verifyAdmissionAsync,
} from '@/lib/auth/native-admission';
import {
  createPasskeyManagementSsoRequest,
  hasActiveNativeDeviceSession,
} from '@/lib/auth/passkey-management';

const START_PATH = '/api/auth/passkey/management/sso/start';

const requestSchema = z.object({
  operation: z.enum(['enroll', 'rename', 'remove']),
});

/**
 * Start the browser half of an SSO primary proof for a passkey change.
 *
 * This exists for accounts whose domain requires SSO and that have no passkey
 * to assert, so the email and passkey proofs cannot serve them. It mints no
 * authority: it creates a `pending` request and returns the URL to open. The
 * grant appears only after the browser proves a fresh SSO sign-in for this
 * account and the app collects it.
 *
 * The caller's bearer must be a live device session, and the device proof is
 * verified here rather than on every poll: this is the only leg that writes.
 */
export const POST = withRestTiming(START_PATH, async (request: Request) => {
  const auth = await getUserFromAuth({
    adminOnly: false,
    requestHeaders: request.headers,
    requestPathname: START_PATH,
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
  const deviceSessionId = auth.deviceSessionId;
  if (!(await hasActiveNativeDeviceSession({ deviceSessionId, userId: auth.user.id }))) {
    return NextResponse.json({ error: 'PASSKEY_MANAGEMENT_DEVICE_UNSUPPORTED' }, { status: 403 });
  }

  const rawBody: unknown = await request.json().catch(() => undefined);
  const parsed = requestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

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

  // SSO is a proof only for accounts that must sign in through it. Everyone
  // else proves this change with the email code or a passkey assertion.
  const domain = getLowerDomainFromEmail(auth.user.google_user_email);
  const authority = domain
    ? await resolveSsoAuthorityForDomain(domain)
    : ({ status: 'not_required' } as const);
  if (authority.status === 'misconfigured') {
    return NextResponse.json({ error: 'SSO_ERROR' }, { status: 503 });
  }
  if (authority.status !== 'required') {
    return NextResponse.json({ error: 'SSO_NOT_REQUIRED' }, { status: 403 });
  }

  const pending = await createPasskeyManagementSsoRequest({
    userId: auth.user.id,
    deviceSessionId,
    operation: parsed.data.operation,
    ssoOrganizationId: authority.sourceOrganizationId,
  });

  const approvalUrl = new URL('/passkey-approval', NEXTAUTH_URL);
  approvalUrl.searchParams.set('request', pending.requestId);

  return NextResponse.json(
    {
      requestId: pending.requestId,
      approvalUrl: approvalUrl.toString(),
      expiresIn: pending.expiresIn,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
});
