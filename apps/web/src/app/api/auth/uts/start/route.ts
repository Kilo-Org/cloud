import type { NextRequest } from 'next/server';
import {
  browserSessionResponse,
  browserSessionSetup,
  startBrowserSignIn,
} from '@kilocode/web-shared/lib/uts-bff/browser-session';
import { isSameOriginNavigation } from '@/lib/auth/same-origin';

/**
 * Starts a UTS browser sign-in (design 5.5): a new PKCE transaction in an HTTP-only cookie, then a
 * 303 to the environment's UTS authorization endpoint. 404 wherever `UTS_BROWSER_SESSIONS` is
 * off. Only a navigation the app started (or a typed URL) on the origin of the registered callback
 * may start one, since the transaction cookie must come back to that callback. `callbackPath` names
 * the app page to return to; anything that is not a page path returns to `/`.
 */
export function GET(request: NextRequest): Response {
  const setup = browserSessionSetup();
  if (setup === null) return browserSessionResponse({ status: 404 });
  if (request.nextUrl.origin !== setup.appOrigin || !isSameOriginNavigation(request)) {
    return browserSessionResponse({ status: 403, text: 'Start the sign-in from the app.' });
  }
  const returnTo = request.nextUrl.searchParams.getAll('callbackPath');
  const { location, setCookie } = startBrowserSignIn(
    setup,
    returnTo.length === 1 ? returnTo[0] : null
  );
  return browserSessionResponse({ status: 303, location, setCookies: [setCookie] });
}
