import type { ConsentStep } from '../third-party/consent';
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
 * checks the membership). A third-party client goes on to the consent screen (`consent`,
 * src/third-party/consent.ts, design 5.9); without one it is denied.
 *
 * RFC 8252 section 8.6: a native client cannot be identified by its redirect. Another app can
 * claim the same private-use scheme, and any local process can listen on a loopback port and start
 * an authorization request that names it. So a first-party request, whose redirect is always a
 * loopback address or a private-use scheme, is approved only from the confirm page's same-origin
 * POST, never a plain GET: every such request shows the user a page (sign-in or confirm), and a
 * request another program started never completes without the user.
 */
export function signInHandoff(deps: SignInDeps, consent: ConsentStep | null): AuthorizationHandoff {
  return async (request, pending) => {
    if (pending.client.kind === 'third_party' && consent === null) return { status: 'denied' };
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
    if (pending.client.kind === 'third_party') {
      return consent === null ? { status: 'denied' } : await consent(request, pending, session);
    }
    if (!isSameOriginPost(request)) {
      return {
        status: 'interaction',
        response: confirmAppPage(pending.client.name, pending.redirectUri),
      };
    }
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
