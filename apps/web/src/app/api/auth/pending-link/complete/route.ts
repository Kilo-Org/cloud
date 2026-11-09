import { NextResponse } from 'next/server';
import { getUserFromSession } from '@kilocode/web-shared/lib/user/server';
import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';
import {
  clearPendingLinkCookie,
  completePendingLink,
  getPendingLinkBySecret,
  pendingLinkPageUrl,
  readPendingLinkSecret,
} from '@/lib/auth/pending-link';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

function redirectTo(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url));
}

export const GET = withRestTiming('/api/auth/pending-link/complete', async (request: Request) => {
  const secret = await readPendingLinkSecret();
  const row = secret ? await getPendingLinkBySecret(secret) : null;
  if (!secret || !row) {
    await clearPendingLinkCookie();
    return redirectTo(request, `${pendingLinkPageUrl}?error=EXPIRED`);
  }

  const sessionUser = await getUserFromSession();
  if (!sessionUser) {
    return redirectTo(request, `${pendingLinkPageUrl}?error=SESSION_REQUIRED`);
  }

  const completed = await completePendingLink(secret, sessionUser.id);
  if (completed.status === 'failed') {
    if (completed.reason === 'EXPIRED') {
      await clearPendingLinkCookie();
    }
    return redirectTo(request, `${pendingLinkPageUrl}?error=${completed.reason}`);
  }

  await clearPendingLinkCookie();
  if (row.kind === 'explicit_link') {
    return redirectTo(request, `/connected-accounts?linked=${completed.provider}`);
  }
  if (row.callback_path && isValidCallbackPath(row.callback_path)) {
    return redirectTo(
      request,
      `/users/after-sign-in?callbackPath=${encodeURIComponent(row.callback_path)}`
    );
  }
  return redirectTo(request, '/users/after-sign-in');
});
