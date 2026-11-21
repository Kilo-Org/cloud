import type { NextRequest, NextResponse } from 'next/server';
import { consumeAppShellHandoff } from '@/lib/app-shell/handoff-token';
import { appShellRedirect } from '@/lib/app-shell/redirect';
import {
  APP_SHELL_ACCOUNT_UNAVAILABLE_PATH,
  APP_SHELL_EXPIRED_PATH,
} from '@/lib/app-shell/shell-paths';
import {
  APP_SHELL_SESSION_COOKIE,
  appShellSessionCookieOptions,
  createAppShellSessionToken,
  loadAppShellUser,
} from '@/lib/app-shell/session';

/**
 * The native app's entry point into the shell. The token is single use: the
 * first request consumes it and receives the session cookie plus a redirect to
 * the target that was stored with it. Anything else — a missing token, a
 * replay, an expired row, an account that the web session path refuses — lands
 * on a terminal "return to the app" page instead of a sign-in page or a full
 * web page.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token') ?? '';
  const handoff = await consumeAppShellHandoff(token);

  if (!handoff) {
    return noStore(appShellRedirect(APP_SHELL_EXPIRED_PATH));
  }

  // The mint already refuses a blocked account, but the token lives for two
  // minutes: re-read the account here so a block recorded in that window cannot
  // become an hour-long session.
  const lookup = await loadAppShellUser(handoff.userId);
  if (lookup.status === 'restricted') {
    return noStore(appShellRedirect(APP_SHELL_ACCOUNT_UNAVAILABLE_PATH));
  }
  if (lookup.status === 'gone') {
    return noStore(appShellRedirect(APP_SHELL_EXPIRED_PATH));
  }

  const response = appShellRedirect(handoff.targetPath);
  response.cookies.set(
    APP_SHELL_SESSION_COOKIE,
    createAppShellSessionToken(handoff.userId),
    appShellSessionCookieOptions()
  );
  return noStore(response);
}

/**
 * The URL carries a one-time credential, so neither the response nor the page
 * it redirects to may be cached, and no referrer may carry the URL onward.
 */
function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
