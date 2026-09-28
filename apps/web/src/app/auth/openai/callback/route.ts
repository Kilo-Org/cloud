import { getUserFromSession, nextAuthHttpHandler } from '@/lib/user/server';
import { getAccountLinkingSession } from '@/lib/account-linking-session';
import { SSO_SIGNIN_PATH } from '@/lib/auth/constants';
import { NextRequest, NextResponse } from 'next/server';

/**
 * The OpenAI OAuth client is registered with the callback path
 * `/auth/openai/callback` (see `OPENAI_REDIRECT_PATH`). NextAuth only knows how
 * to complete a callback at `/api/auth/callback/<provider>`, so this route
 * rewrites the request to that path before delegating.
 *
 * Every NextAuth 4 cookie uses `path: '/'`, so the state, PKCE and nonce
 * cookies set when the sign-in started are present here.
 *
 * Nothing on this path is trusted before the token exchange: no claim is read
 * and no account is matched until NextAuth has verified the ID token.
 */
const NEXT_AUTH_CALLBACK_PATH = '/api/auth/callback/openai';

/**
 * NextAuth's App Router adapter takes the action and provider from
 * `context.params.nextauth` (`next-auth/next/index.js`); it never derives them
 * from the URL. This static route has no dynamic params of its own, so the
 * delegated call must carry the ones the real `/api/auth/[...nextauth]` route
 * receives. Without them NextAuth falls back to its legacy API-handler adapter,
 * which reads `req.query` and cannot read a `NextRequest`, so the callback
 * would never reach the token exchange.
 */
const NEXT_AUTH_CALLBACK_CONTEXT = {
  params: Promise.resolve({
    nextauth: NEXT_AUTH_CALLBACK_PATH.split('/').slice(3),
  }),
};

/**
 * The locations a failed callback redirect can land on. NextAuth's callback
 * action surfaces an internal failure at `/api/auth/error`, which always
 * carries the failure code in its `error` query parameter, and at the bare
 * `/api/auth/signin` hop it returns when the token exchange produced no usable
 * profile or account (`next-auth/core/routes/callback.js`). The app's own
 * sign-in route (`SSO_SIGNIN_PATH`) is the third: the callback's `signIn`
 * callback returns it with a failure code when it refuses an authorization
 * (`authFailureRedirectUrl` in `@/lib/auth/redirect-urls`).
 */
const NEXT_AUTH_ERROR_PATH = '/api/auth/error';
const NEXT_AUTH_SIGNIN_PATH = '/api/auth/signin';

/**
 * The failure code used for the bare sign-in hop, which carries none of its
 * own. It is NextAuth's own code for a callback-stage failure
 * (`next-auth/core/routes/callback.js`).
 */
const DEFAULT_CALLBACK_FAILURE_CODE = 'OAuthCallback';

async function redirectToByok(request: NextRequest, errorCode: string): Promise<NextResponse> {
  // An organization connect returns to the organization's BYOK page. The
  // linking session still holds the organization on the declined/failed path,
  // where NextAuth has not consumed it.
  const organizationId = (await getAccountLinkingSession())?.organizationId;
  const redirectUrl = new URL(
    organizationId ? `/organizations/${organizationId}/byok` : '/byok',
    request.nextUrl.origin
  );
  redirectUrl.searchParams.set('openai_error', errorCode);
  return NextResponse.redirect(redirectUrl);
}

/**
 * NextAuth reports a callback-stage failure (a rejected or expired code, a
 * wrong client secret, a network error during the token exchange) with a 3xx to
 * `/api/auth/error`, a callback whose exchange yields no usable profile with a
 * 3xx to `/api/auth/signin` carrying no error code, and a refusal from the
 * callback's `signIn` callback with a 3xx to the app's own sign-in route
 * carrying the refusal code. A person who started the connect from the BYOK card
 * would land on the sign-in page with no way back and no card message, so this
 * turns any of those redirects into the card's readable failure. The browser
 * follows the error hop itself, so the first
 * response is the only chance to catch it here.
 *
 * Returns null - leaving NextAuth's response untouched - unless this is a real
 * authorization-code callback (a sign-in start or a providers fetch must not be
 * touched), the failure location is one of the known failure hops, a failure
 * is available (the hop's own, or the default for the bare sign-in hop), and
 * the request still has a session. Without a session this is a failed sign-up,
 * which must keep landing on the sign-in page with NextAuth's existing readable
 * error. Nothing here is logged, so no token or secret can leak into a log
 * line.
 */
async function redirectCallbackFailureToByok(
  response: Response,
  request: NextRequest
): Promise<Response | null> {
  if (!request.nextUrl.searchParams.get('code')) {
    return null;
  }
  if (response.status < 300 || response.status >= 400) {
    return null;
  }
  const location = response.headers.get('location');
  if (!location) {
    return null;
  }
  const failureUrl = new URL(location, request.url);
  const isErrorHop = failureUrl.pathname === NEXT_AUTH_ERROR_PATH;
  const isSignInHop = failureUrl.pathname === NEXT_AUTH_SIGNIN_PATH;
  // When the linking session expired, the callback's `signIn` callback refuses
  // the link and redirects to the app's sign-in route with a failure code
  // (`TURNSTILE_REQUIRED` among others), so that hop is the connect's failure
  // and must reach the card like the two NextAuth hops above.
  const isAppSignInHop = failureUrl.pathname === SSO_SIGNIN_PATH;
  if (!isErrorHop && !isSignInHop && !isAppSignInHop) {
    return null;
  }
  const carriedCode = failureUrl.searchParams.get('error');
  // Only the bare NextAuth sign-in hop may fail without a code. The app's sign-in
  // route is shared with the plain sign-in flow, so a code-free redirect there
  // stays on the sign-in page.
  const errorCode = carriedCode || (isSignInHop ? DEFAULT_CALLBACK_FAILURE_CODE : null);
  if (!errorCode) {
    return null;
  }
  const session = await getUserFromSession();
  if (!session) {
    return null;
  }
  return redirectToByok(request, errorCode);
}

async function handler(request: NextRequest, _context: unknown) {
  const errorCode = request.nextUrl.searchParams.get('error');

  // A declined or failed connect should return a signed-in person to the BYOK
  // page rather than to the sign-in page. Only a real session can select that
  // destination; without one the request falls through to NextAuth, which
  // surfaces the error on its own terms.
  if (errorCode) {
    const session = await getUserFromSession();
    if (session) {
      return redirectToByok(request, errorCode);
    }
  }

  const rewrittenUrl = request.nextUrl.clone();
  rewrittenUrl.pathname = NEXT_AUTH_CALLBACK_PATH;
  const response = await nextAuthHttpHandler(
    new NextRequest(rewrittenUrl, request),
    NEXT_AUTH_CALLBACK_CONTEXT
  );
  const failure = await redirectCallbackFailureToByok(response, request);
  return failure ?? response;
}

export { handler as GET };
