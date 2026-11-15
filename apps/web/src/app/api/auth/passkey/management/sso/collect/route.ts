import { NextResponse } from 'next/server';
import * as z from 'zod';

import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { getLowerDomainFromEmail } from '@kilocode/web-shared/lib/email-address';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';

import {
  collectPasskeyManagementSsoGrant,
  hasActiveNativeDeviceSession,
  readPasskeyManagementSsoRequest,
} from '@/lib/auth/passkey-management';

const COLLECT_PATH = '/api/auth/passkey/management/sso/collect';

const requestSchema = z.object({
  requestId: z.string().uuid(),
});

/**
 * Collect the grant for an SSO management request the app started.
 *
 * Cheap by design: the device proof was verified when the request started, so
 * polling only reads the request state and, once approved, exchanges it for the
 * grant in one transaction. `429`/`425` are answers, not errors the app should
 * surface: `SSO_APPROVAL_PENDING` means "the browser has not approved yet".
 */
export const POST = withRestTiming(COLLECT_PATH, async (request: Request) => {
  const auth = await getUserFromAuth({
    adminOnly: false,
    requestHeaders: request.headers,
    requestPathname: COLLECT_PATH,
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

  // Scoped to this account and this device session: another session of the
  // same account cannot pick up a grant, and a request that expired, was
  // collected, or was started elsewhere reads as absent.
  const pending = await readPasskeyManagementSsoRequest({
    requestId: parsed.data.requestId,
    userId: auth.user.id,
    deviceSessionId,
  });
  if (!pending) {
    return NextResponse.json({ error: 'SSO_APPROVAL_INVALID' }, { status: 403 });
  }
  if (pending.state === 'pending') {
    return NextResponse.json({ error: 'SSO_APPROVAL_PENDING' }, { status: 425 });
  }

  // The policy that authorized the approval must still be the live one: a
  // domain that stopped requiring SSO, or moved to another organization,
  // must not yield a grant recorded under the old one.
  const domain = getLowerDomainFromEmail(auth.user.google_user_email);
  const authority = domain
    ? await resolveSsoAuthorityForDomain(domain)
    : ({ status: 'not_required' } as const);
  if (
    authority.status !== 'required' ||
    !pending.ssoOrganizationId ||
    authority.sourceOrganizationId !== pending.ssoOrganizationId
  ) {
    return NextResponse.json({ error: 'SSO_APPROVAL_INVALID' }, { status: 403 });
  }

  const grant = await collectPasskeyManagementSsoGrant({
    requestId: parsed.data.requestId,
    userId: auth.user.id,
    deviceSessionId,
  });
  if (!grant) {
    return NextResponse.json({ error: 'SSO_APPROVAL_INVALID' }, { status: 403 });
  }

  return NextResponse.json(
    {
      authorization: grant.token,
      operation: grant.operation,
      expiresIn: grant.expiresIn,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
});
