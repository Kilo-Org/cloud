import type { AuthorizationHandoff } from '../oauth/authorize';
import { classifyFailure } from '../oauth/errors';
import { sha256 } from '../token/credentials';
import type { SignInDeps } from './deps';
import { returnPathOf, signInChoices } from './flows';
import { confirmAppPage, signInPage, unavailablePage } from './pages';
import { isSameOriginPost } from './requests';
import { sessionCookieValue } from './session';
import type { BrowserSession } from './store';

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
 *
 * RFC 8252 section 8.6: a client that receives its code on a private-use URI scheme cannot be
 * identified, because another app can claim the same scheme. Its request is approved only from
 * the confirm page's same-origin POST, so every such request shows the user a page (sign-in or
 * confirm) and a request another app started never completes without the user. The web BFF
 * `kilo-web` receives its code on its exact HTTPS callback, which no other app can claim, and
 * redeems it only with its client assertion, so its request never shows the confirm page.
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
    if (session === null) {
      // A provider, SSO or email sign-in returns to this authorization request.
      const { pathname, search } = new URL(request.url);
      const choices = signInChoices(deps.methods, returnPathOf(`${pathname}${search}`));
      return { status: 'interaction', response: signInPage(choices) };
    }
    const approval = {
      clientKind: 'first_party',
      accountId: session.accountId,
      browserSessionId: session.sessionId,
      authTime: session.authTime,
      amr: session.amr,
      orgId: pending.orgHint,
    } as const;
    if (pending.client.kind === 'confidential_web') return { status: 'approved', approval };
    if (pending.client.redirectKind === 'private_use_scheme' && !isSameOriginPost(request)) {
      return {
        status: 'interaction',
        response: confirmAppPage(pending.client.name, pending.redirectUri),
      };
    }
    return { status: 'approved', approval };
  };
}
