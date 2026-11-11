import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromSessionForCredentialIssuanceOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { isPagesAuthOrigin, pagesAuthCallbackUrl } from '@/lib/pages-auth/pages-auth-clients';
import { createPagesAuthCode, PAGES_AUTH_STATE_PATTERN } from '@/lib/pages-auth/pages-auth-code';

/** The one value of a query parameter, or null when it is absent or repeated. */
function single(params: URLSearchParams, name: string): string | null {
  const [value, ...others] = params.getAll(name);
  return value !== undefined && others.length === 0 ? value : null;
}

/**
 * Signs a person in to a Pages deployment with their Kilo session.
 *
 * Pages sends the browser here with its own origin and a `state`. A person
 * without a session signs in first and comes back. The browser is then sent to
 * the deployment's fixed callback with a short-lived code and the same
 * `state`, and Pages trades the code for who signed in
 * (`/api/pages-auth/exchange`).
 *
 * Only a web session counts: a request carrying an Authorization header is
 * sent to sign in, as on the other pages that issue something for a session.
 * The link is checked before anyone is asked to sign in, so a link naming
 * another site never starts a sign-in.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const origin = single(params, 'origin');
  const state = single(params, 'state');

  if (!origin || !state || !isPagesAuthOrigin(origin) || !PAGES_AUTH_STATE_PATTERN.test(state)) {
    return new NextResponse('This sign-in link is not valid.', {
      status: 400,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const returnPath = `/pages-auth?${new URLSearchParams({ origin, state }).toString()}`;
  const user = await getUserFromSessionForCredentialIssuanceOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(returnPath)}`
  );

  const code = createPagesAuthCode({ userId: user.id, origin, state });
  const response = NextResponse.redirect(pagesAuthCallbackUrl(origin, { code, state }), 303);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
