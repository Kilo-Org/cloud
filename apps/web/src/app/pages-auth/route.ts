import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromSessionForCredentialIssuanceOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { isPagesAuthAudience, pagesAuthCallbackUrl } from '@/lib/pages-auth/pages-auth-clients';
import { createPagesAuthCode, PAGES_AUTH_STATE_PATTERN } from '@/lib/pages-auth/pages-auth-code';

/** The one value of a query parameter, or null when it is absent or repeated. */
function single(params: URLSearchParams, name: string): string | null {
  const [value, ...others] = params.getAll(name);
  return value !== undefined && others.length === 0 ? value : null;
}

function invalidLink(): NextResponse {
  return new NextResponse('This sign-in link is not valid.', {
    status: 400,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

/**
 * Signs a person in to a Pages deployment with their Kilo session.
 *
 * Pages sends the browser here with its `audience` (`pages` or `pages-dev`) and
 * a `state`. A person without a session signs in first and comes back. The
 * browser is then sent to the deployment's fixed callback, which Kilo looks up
 * from the audience, with a short-lived code and the same `state`, and Pages
 * trades the code for who signed in (`/api/pages-auth/exchange`).
 *
 * Only a web session counts: a request carrying an Authorization header is
 * sent to sign in, as on the other pages that issue something for a session.
 * The link is checked before anyone is asked to sign in, so a link naming
 * an unknown deployment never starts a sign-in.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const audience = single(params, 'audience');
  const state = single(params, 'state');

  if (
    !audience ||
    !state ||
    !isPagesAuthAudience(audience) ||
    !PAGES_AUTH_STATE_PATTERN.test(state)
  ) {
    return invalidLink();
  }

  const returnPath = `/pages-auth?${new URLSearchParams({ audience, state }).toString()}`;
  const user = await getUserFromSessionForCredentialIssuanceOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(returnPath)}`
  );

  const code = createPagesAuthCode({ userId: user.id, audience, state });
  const callbackUrl = pagesAuthCallbackUrl(audience, { code, state });
  if (!callbackUrl) return invalidLink();
  const response = NextResponse.redirect(callbackUrl, 303);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
