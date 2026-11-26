import type { AuthorizationHandoff } from '../oauth/authorize';
import { classifyFailure } from '../oauth/errors';
import { sha256 } from '../token/credentials';
import type { SignInDeps } from './deps';
import { signInPage, unavailablePage } from './pages';
import { sessionCookieValue } from './session';
import type { BrowserSession } from './store';

/**
 * RFC 8252 section 8.6: a client that receives its code on a private-use URI scheme cannot be
 * identified, because another app can claim the same scheme, so its request is approved only for
 * a sign-in this recent. The sign-in page then makes the user sign in, so a request another app
 * started never completes without the user.
 */
export const FRESH_SIGN_IN_SECONDS = 5 * 60;

/** The browser session the request's cookie names, or null. */
export async function requestSession(
  request: Request,
  deps: SignInDeps
): Promise<BrowserSession | null> {
  const value = sessionCookieValue(request);
  if (value === null) return null;
  const tokenHash = await sha256(value);
  return await deps.signIn(store => store.readSession(tokenHash));
}

/**
 * The authorization hand-off of the sign-in pages. Without a session the user sees the sign-in
 * page at the authorization URL, which reloads it once the user signed in. A first-party client is
 * approved for the session's account, with the organization it asked for (the identity store
 * checks the membership). A third-party client is denied until the consent screen serves it
 * (design 5.9).
 */
export function signInHandoff(deps: SignInDeps): AuthorizationHandoff {
  return async (request, pending) => {
    if (pending.client.kind === 'third_party') return { status: 'denied' };
    let session: BrowserSession | null;
    try {
      session = await requestSession(request, deps);
    } catch (error) {
      return {
        status: 'interaction',
        response: unavailablePage(classifyFailure(error, 'authorize') === 'retryable'),
      };
    }
    const fresh =
      session !== null &&
      (pending.client.redirectKind === 'loopback' ||
        Date.now() - session.authTime.getTime() < FRESH_SIGN_IN_SECONDS * 1000);
    if (session === null || !fresh) return { status: 'interaction', response: signInPage() };
    return {
      status: 'approved',
      approval: {
        clientKind: 'first_party',
        accountId: session.accountId,
        browserSessionId: session.sessionId,
        authTime: session.authTime,
        amr: session.amr,
        orgId: pending.orgHint,
      },
    };
  };
}
