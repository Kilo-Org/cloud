import { UTS_SSO_CALLBACK_PATH, UTS_SSO_START_PATH } from '@kilocode/uts-contracts';
import { jsonResponse } from '../../responses';
import {
  type SignInMethods,
  beginFlow,
  finishFlow,
  isSameOriginPost,
  readForm,
  returnPathOf,
} from '../flows';
import { messagePage } from '../pages';
import { logMisconfigured } from '../providers/config';
import { normalizeEmail, workosIdentity } from '../providers/exchange';

/**
 * WorkOS SSO (design 5.1, 5.2, 5.8).
 *
 * * `POST /signin/sso/start` takes the user's address from the sign-in page. Its domain must be a
 *   verified domain of an org with exactly one active connection; the flow records that
 *   connection, and the user goes to WorkOS with `connection` set, so WorkOS signs in through the
 *   org's identity provider only.
 * * `GET /signin/sso/callback` buys the profile with the code and the API key; the identity store
 *   accepts it only when the profile names the flow's connection and its address lies in a domain
 *   that connection's org verified. SSO never links to an existing account by email.
 */
export async function handleSsoRequest(
  request: Request,
  pathname: string,
  methods: SignInMethods
): Promise<Response | null> {
  if (pathname !== UTS_SSO_START_PATH && pathname !== UTS_SSO_CALLBACK_PATH) return null;
  const sso = methods.settings.sso;
  if (sso.status === 'off') return null;
  if (sso.status === 'misconfigured') {
    logMisconfigured('workos', sso.missing);
    return messagePage('Sign in to Kilo', 'Single sign-on is not available.', 500, null);
  }
  const redirectUri = `${methods.config.endpoints.issuer}${UTS_SSO_CALLBACK_PATH}`;

  if (pathname === UTS_SSO_START_PATH) {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    }
    if (!isSameOriginPost(request)) return jsonResponse({ error: 'forbidden_origin' }, 403);
    const form = await readForm(request);
    const returnTo = returnPathOf(form?.get('return_to') ?? null);
    const email = normalizeEmail(form?.get('email'));
    if (form === null || email === null) {
      return messagePage('Sign in to Kilo', 'Enter your work email address.', 400, returnTo);
    }
    return await beginFlow(
      request,
      methods,
      'workos',
      {
        returnTo,
        intent: form.get('intent'),
        gatePass: form.get('gate_pass'),
        ssoDomain: email.split('@')[1],
      },
      (values, connection) => {
        // The start statement returns the connection of every SSO flow it stores.
        if (connection === null) return null;
        const url = new URL(sso.endpoints.authorization);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', sso.clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('state', values.state);
        url.searchParams.set('connection', connection);
        return url;
      }
    );
  }

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  }
  const params = new URL(request.url).searchParams;
  const code = params.get('code');
  if (params.get('error') !== null || code === null) {
    return messagePage('Sign in to Kilo', 'The single sign-on was not completed.', 400, null);
  }
  return await finishFlow(request, methods, 'workos', params.get('state'), () =>
    workosIdentity(sso.endpoints.token, sso.clientId, sso.apiKey, code)
  );
}
