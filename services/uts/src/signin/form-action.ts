import { UTS_AUTHORIZE_PATH, type UtsEnvironment, firstPartyClient } from '@kilocode/uts-contracts';
import { isRegisteredWebRedirect } from '../oauth/clients';
import { paramsOf } from '../oauth/params';

/** The base `returnTo` resolves against: a return path that leaves it names another origin. */
const RETURN_BASE = 'https://issuer.invalid';

const DEVELOPMENT_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * The client origin a sign-in page's `form-action` names beside `'self'`.
 *
 * Browsers apply `form-action` to every redirect that follows a form submission. A sign-in form
 * answers with a redirect to `returnTo`. When `returnTo` is an authorization request of the web
 * BFF `kilo-web`, the hand-off approves it without another page (src/signin/handoff.ts), and
 * `/authorize` redirects on to the BFF's callback on another origin. Every other authorization
 * request first shows an issuer page: the confirm page for a native client and the consent page
 * for a third-party client. Each of those pages names its own redirect in its policy.
 *
 * `returnTo` comes from a form field, or from the identity store that kept it, so this function
 * checks it the way `/authorize` does. The path must be the authorization endpoint, `client_id`
 * must name the web client exactly once, and `redirect_uri` must appear exactly once and be one of
 * the URIs the client registered for `environment`. The result is that registered URI's origin,
 * and only when the URI is HTTPS, or HTTP on `localhost` or `127.0.0.1` in development. In every
 * other case the result is null, and the page keeps `form-action 'self'`.
 */
export function clientReturnOrigin(
  returnTo: string | null,
  environment: UtsEnvironment
): string | null {
  if (returnTo === null) return null;
  let url: URL;
  try {
    url = new URL(returnTo, RETURN_BASE);
  } catch {
    return null;
  }
  if (url.origin !== RETURN_BASE || url.pathname !== UTS_AUTHORIZE_PATH) return null;
  const params = paramsOf(url.searchParams);
  const clientId = params.one('client_id');
  const redirectUri = params.one('redirect_uri');
  if (clientId.status !== 'present' || redirectUri.status !== 'present') return null;
  const client = firstPartyClient(clientId.value);
  if (
    client?.kind !== 'confidential_web' ||
    !isRegisteredWebRedirect(client, environment, redirectUri.value)
  ) {
    return null;
  }
  // A registered URI is a constant of the client registry, so it always parses.
  const redirect = new URL(redirectUri.value);
  if (redirect.protocol === 'https:') return redirect.origin;
  const developmentLoopback =
    environment === 'development' &&
    redirect.protocol === 'http:' &&
    DEVELOPMENT_LOOPBACK_HOSTS.has(redirect.hostname);
  return developmentLoopback ? redirect.origin : null;
}
