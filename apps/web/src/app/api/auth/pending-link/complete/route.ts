import { NextResponse } from 'next/server';
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
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

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
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
  }

  const secret = await readPendingLinkSecret();
  const row = secret ? await getPendingLinkBySecret(secret) : null;
  if (!secret || !row) {
    await clearPendingLinkCookie();
    return NextResponse.json({ error: 'EXPIRED' }, { status: 404 });
  }

  const sessionUser = (await getUserFromSessionForCredentialIssuance()).user;
  if (!sessionUser) {
    return NextResponse.json({ error: 'SESSION_REQUIRED' }, { status: 401 });
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
  return NextResponse.json({
    redirectTo: redirectTargetFor(row.kind, completed.provider, row.callback_path),
  });
});
