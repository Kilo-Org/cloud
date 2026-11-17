import { NextResponse } from 'next/server';
import * as z from 'zod';

import { NEXTAUTH_URL } from '@kilocode/web-shared/lib/config.server';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { getUserFromSessionForCredentialIssuance } from '@kilocode/web-shared/lib/user/server';

import { approvePasskeyManagementSsoRequest } from '@/lib/auth/passkey-management';
import { evaluatePasskeyManagementApproval } from '@/lib/auth/passkey-management-approval';

const APPROVE_PATH = '/api/auth/passkey/management/approve';

const formSchema = z.object({
  request: z.string().uuid(),
});

function approvalPageUrl(requestId: string, params: Record<string, string>): string {
  const url = new URL('/passkey-approval', NEXTAUTH_URL);
  if (requestId) {
    url.searchParams.set('request', requestId);
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Approve the browser half of an SSO management proof.
 *
 * Cookie-only and same-origin: a bearer never takes this path, and the form
 * must come from this site, so a page on another origin cannot approve with
 * the reader's session. Every condition that the approval page shows is
 * re-derived here, and the write itself re-checks the same conditions in SQL,
 * so a stale tab cannot approve a request that has since expired or moved.
 */
export const POST = withRestTiming(APPROVE_PATH, async (request: Request) => {
  const origin = request.headers.get('origin');
  if (request.headers.has('authorization') || origin !== new URL(NEXTAUTH_URL).origin) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const form = await request.formData().catch(() => undefined);
  const parsed = formSchema.safeParse({ request: form?.get('request') });
  if (!parsed.success) {
    return NextResponse.redirect(approvalPageUrl('', { error: 'invalid_request' }), 303);
  }
  const requestId = parsed.data.request;

  const auth = await getUserFromSessionForCredentialIssuance();
  if (!auth.user) {
    return NextResponse.redirect(approvalPageUrl(requestId, { error: 'sign_in' }), 303);
  }

  const state = await evaluatePasskeyManagementApproval({
    requestId,
    session: {
      userId: auth.user.id,
      email: auth.user.google_user_email,
      authenticatedAt: auth.authenticatedAt,
      ssoSourceOrganizationId: auth.ssoSourceOrganizationId,
    },
  });
  if (state.status !== 'ready') {
    return NextResponse.redirect(approvalPageUrl(requestId, { error: state.status }), 303);
  }

  const approved = await approvePasskeyManagementSsoRequest({
    requestId,
    userId: auth.user.id,
    ssoOrganizationId: state.requiredOrganizationId,
  });
  if (!approved) {
    return NextResponse.redirect(approvalPageUrl(requestId, { error: 'expired' }), 303);
  }

  return NextResponse.redirect(approvalPageUrl(requestId, { status: 'approved' }), 303);
});
