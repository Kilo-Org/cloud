import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { consumeAppShellHandoff } from '@/lib/app-shell/handoff-token';
import { APP_SHELL_EXPIRED_PATH } from '@/lib/app-shell/shell-paths';
import {
  APP_SHELL_SESSION_COOKIE,
  appShellSessionCookieOptions,
  createAppShellSessionToken,
} from '@/lib/app-shell/session';

/**
 * The native app's entry point into the shell. The token is single use: the
 * first request consumes it and receives the session cookie plus a redirect to
 * the target that was stored with it. Anything else — a missing token, a
 * replay, an expired row — lands on the terminal "return to the app" page
 * instead of a sign-in page or a full web page.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token') ?? '';
  const handoff = await consumeAppShellHandoff(token);

  if (!handoff) {
    return noStore(NextResponse.redirect(new URL(APP_SHELL_EXPIRED_PATH, request.url)));
  }

  const response = NextResponse.redirect(new URL(handoff.targetPath, request.url));
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
