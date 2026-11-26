import {
  UtsOAuthProviderSchema,
  utsProviderCallbackPath,
} from '@kilocode/uts-contracts';
import { jsonResponse } from '../../responses';
import {
  type SignInMethods,
  beginFlow,
  finishFlow,
  readForm,
  refusalPage,
  returnPathOf,
} from '../flows';
import { messagePage } from '../pages';
import { logMisconfigured } from './config';
import { authorizationUrl, providerIdentity } from './exchange';

/**
 * `GET /signin/oauth/<provider>/start` and the provider's callback (design 5.1). A provider that is
 * not configured is not served (404); a misconfigured one answers 500.
 *
 * The callback is a GET with `code` and `state`, except for Apple, whose `form_post` callback is a
 * cross-site POST; the state and the binder protect it, so it needs no `Origin` check.
 */
const PROVIDER_PATH = /^\/signin\/oauth\/([a-z]+)\/(start|callback)$/;

export async function handleProviderRequest(
  request: Request,
  pathname: string,
  methods: SignInMethods
): Promise<Response | null> {
  const match = PROVIDER_PATH.exec(pathname);
  if (match === null) return null;
  const provider = UtsOAuthProviderSchema.safeParse(match[1]);
  if (!provider.success) return null;
  const settings = methods.settings.providers[provider.data];
  if (settings.status === 'off') return null;
  if (settings.status === 'misconfigured') {
    logMisconfigured(provider.data, settings.missing);
    return messagePage('Sign in to Kilo', 'This sign-in method is not available.', 500, null);
  }
  const { spec, credentials } = settings;
  const redirectUri = `${methods.config.endpoints.issuer}${utsProviderCallbackPath(provider.data)}`;

  if (match[2] === 'start') {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    }
    const params = new URL(request.url).searchParams;
    return await beginFlow(
      request,
      methods,
      provider.data,
      {
        returnTo: returnPathOf(params.get('return_to')),
        intent: params.get('intent'),
        gatePass: params.get('gate_pass'),
        ssoDomain: null,
      },
      values => authorizationUrl(spec, credentials.clientId, redirectUri, values)
    );
  }

  const formPost = spec.protocol === 'oidc' && spec.responseMode === 'form_post';
  const expected = formPost ? 'POST' : 'GET';
  if (request.method !== expected) {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: expected });
  }
  const params = formPost ? await readForm(request) : new URL(request.url).searchParams;
  if (params === null) return refusalPage('invalid_state', null);
  const code = params.get('code');
  if (params.get('error') !== null || code === null) {
    // The user cancelled at the provider, or the provider refused; the flow expires unused.
    return messagePage('Sign in to Kilo', 'The sign-in was not completed.', 400, null);
  }
  return await finishFlow(request, methods, provider.data, params.get('state'), secrets =>
    providerIdentity(spec, credentials, {
      code,
      redirectUri,
      verifier: secrets.verifier,
      nonce: secrets.nonce,
    })
  );
}
