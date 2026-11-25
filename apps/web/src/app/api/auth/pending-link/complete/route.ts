import { NextResponse } from 'next/server';
import * as z from 'zod';
import type { PendingAuthLink, User } from '@kilocode/db/schema';
import { getUserFromSessionForCredentialIssuance } from '@kilocode/web-shared/lib/user/server';
import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';
import { isSameOrigin } from '@/lib/auth/same-origin';
import {
  clearPendingLinkCookie,
  completePendingLink,
  getPendingLinkBySecret,
  isPendingLinkLive,
  pendingLinkPageUrl,
  readPendingLinkSecret,
} from '@/lib/auth/pending-link';
import { authorizeSignInMethodChange } from '@/lib/auth/sign-in-method-change';
import { consumeSignInMethodChangeCode } from '@/lib/auth/sign-in-method-change-email-code';
import {
  SIGN_IN_METHOD_CHANGE_CODE_LENGTH,
  SIGN_IN_METHOD_CHANGE_REFUSAL_CODES,
  type SignInMethodChangeRefusal,
} from '@/lib/auth/sign-in-method-change-codes';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import {
  auditAuthRoute,
  authAuditRequestFromHeaders,
  type AuthAuditAttempt,
} from '@/lib/auth/auth-audit';

const codeProofSchema = z.object({
  code: z.string().regex(new RegExp(`^\\d{${SIGN_IN_METHOD_CHANGE_CODE_LENGTH}}$`)),
  challengeId: z.uuid(),
});

function refused(refusal: SignInMethodChangeRefusal, status: number): NextResponse {
  return NextResponse.json({ error: SIGN_IN_METHOD_CHANGE_REFUSAL_CODES[refusal] }, { status });
}

/**
 * An existing-account link adds a sign-in method to the signed-in account, so,
 * like a link started from Connected accounts, it needs the code emailed to the
 * account's primary address for that change, bound to this browser session. A
 * session cookie alone does not prove the mailbox, and the identity being added
 * may have an email claim that its provider never verified. An explicit link
 * spent its code when it started, so it needs none here.
 *
 * Returns the refusal, or null once the code is spent. The account checks run
 * first, so a refused request does not spend the code.
 */
async function refuseUnprovenExistingAccountLink(
  request: Request,
  row: PendingAuthLink,
  sessionUser: User,
  webSessionId: string | undefined
): Promise<NextResponse | null> {
  if (sessionUser.id !== row.kilo_user_id) {
    return NextResponse.json({ error: 'WRONG_ACCOUNT' }, { status: 403 });
  }
  if (!webSessionId) return refused('sessionReauthRequired', 403);
  const policyRefusal = await authorizeSignInMethodChange({ user: sessionUser, change: 'link' });
  if (policyRefusal) return refused(policyRefusal, 403);

  const proof = codeProofSchema.safeParse(await request.json().catch(() => undefined));
  if (!proof.success) return refused('codeInvalid', 400);
  const result = await consumeSignInMethodChangeCode(
    {
      userId: sessionUser.id,
      email: sessionUser.google_user_email,
      change: 'link',
      provider: row.provider,
      webSessionId,
    },
    proof.data.code,
    proof.data.challengeId
  );
  if (result === 'invalid') return refused('codeInvalid', 400);
  if (result === 'locked') return refused('codeLocked', 429);
  return null;
}

/**
 * Redirect to a path on whatever origin the browser actually uses.
 *
 * Deliberately not `NextResponse.redirect(new URL(path, request.url))`: the dev
 * server binds 0.0.0.0, so `request.url` reports that origin even when the
 * browser is on localhost, and the cross-origin hop drops the session cookie.
 * A relative Location resolves against the current origin.
 */
function redirectTo(path: string): NextResponse {
  return new NextResponse(null, {
    status: 307,
    headers: { Location: path, 'Cache-Control': 'no-store' },
  });
}

/** The destination after a confirmed attach. */
function redirectTargetFor(kind: string, provider: string, callbackPath: string | null): string {
  if (kind === 'explicit_link') {
    return `/connected-accounts?linked=${provider}`;
  }
  if (callbackPath && isValidCallbackPath(callbackPath)) {
    return `/users/after-sign-in?callbackPath=${encodeURIComponent(callbackPath)}`;
  }
  return '/users/after-sign-in';
}

export const GET = withRestTiming('/api/auth/pending-link/complete', async () => {
  const secret = await readPendingLinkSecret();
  const row = secret ? await getPendingLinkBySecret(secret) : null;
  if (!secret || !row) {
    await clearPendingLinkCookie();
    return redirectTo(`${pendingLinkPageUrl}?error=EXPIRED`);
  }

  const sessionUser = (await getUserFromSessionForCredentialIssuance()).user;
  if (!sessionUser) {
    return redirectTo(`${pendingLinkPageUrl}?error=SESSION_REQUIRED`);
  }
  if (sessionUser.id !== row.kilo_user_id) {
    return redirectTo(`${pendingLinkPageUrl}?error=WRONG_ACCOUNT`);
  }
  return redirectTo(`${pendingLinkPageUrl}?confirm=1`);
});

export const POST = withRestTiming('/api/auth/pending-link/complete', async (request: Request) => {
  // A refusal is recorded here; the link itself is recorded by
  // recordSignInMethodChange when completePendingLink attaches it.
  const attempt: AuthAuditAttempt = { action: 'auth.sign_in_method.link' };
  return auditAuthRoute(
    authAuditRequestFromHeaders(request.headers, '/api/auth/pending-link/complete'),
    attempt,
    () => attachPendingLink(request, attempt)
  );
});

async function attachPendingLink(request: Request, attempt: AuthAuditAttempt): Promise<Response> {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
  }

  const secret = await readPendingLinkSecret();
  const row = secret ? await getPendingLinkBySecret(secret) : null;
  if (!secret || !row) {
    await clearPendingLinkCookie();
    return NextResponse.json({ error: 'EXPIRED' }, { status: 404 });
  }
  attempt.userId = row.kilo_user_id;
  attempt.method = row.provider;

  const session = await getUserFromSessionForCredentialIssuance();
  const sessionUser = session.user;
  if (!sessionUser) {
    return NextResponse.json({ error: 'SESSION_REQUIRED' }, { status: 401 });
  }

  if (row.kind === 'existing_account') {
    const refusal = await refuseUnprovenExistingAccountLink(
      request,
      row,
      sessionUser,
      session.webSessionId
    );
    if (refusal) return refusal;
  }

  const completed = await completePendingLink(secret, sessionUser.id);
  if (completed.status === 'failed') {
    if (completed.reason === 'EXPIRED' && !(await isPendingLinkLive(secret))) {
      await clearPendingLinkCookie();
    }
    return NextResponse.json(
      { error: completed.reason },
      { status: completed.reason === 'EXPIRED' ? 404 : 403 }
    );
  }

  await clearPendingLinkCookie();
  attempt.skipSuccessRow = true;
  return NextResponse.json({
    redirectTo: redirectTargetFor(row.kind, completed.provider, row.callback_path),
  });
}
