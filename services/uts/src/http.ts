import { UTS_AUTHORIZATION_SERVER_METADATA_PATH } from '@kilocode/uts-contracts';
import { readConfig, type Env } from './env';
import { authorizationServerMetadata } from './metadata/authorization-server';
import { type HandoffChoice, handleOAuthRequest, oauthService } from './oauth/routes';
import { jsonResponse } from './responses';
import type { SignInMailer } from './signin/email/mailer';
import type { SignerAccess } from './token/mint';

/**
 * What only the development entry adds: a choice of the synthetic sign-in hand-off, a failing
 * signer for the local end-to-end run and a recording mail port for the email sign-in
 * (src/dev.ts). Null is the deployed behaviour.
 */
export type MintOptions = {
  authorizationHandoff: HandoffChoice | null;
  signer: SignerAccess | null;
  mailer: SignInMailer | null;
};

const DEPLOYED: MintOptions = { authorizationHandoff: null, signer: null, mailer: null };

/**
 * The mint Worker's fetch handler. Placement runs it next to the identity store's primary, which
 * applies to fetch handlers only, not to RPC methods or named entrypoints (design 5.2). It serves
 * the issuer metadata, and the OAuth endpoints, the sign-in pages, the device grant and the
 * tickets once the identity store is bound (src/oauth/routes.ts). Signer keys are served by the
 * `SignerKeys` entrypoint (src/signer-keys.ts), never by this handler.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: MintOptions = DEPLOYED
): Promise<Response> {
  const config = readConfig(env);
  const { pathname } = new URL(request.url);
  const oauth = oauthService(
    env,
    ctx,
    config,
    options.authorizationHandoff,
    options.signer,
    options.mailer
  );
  if (pathname === UTS_AUTHORIZATION_SERVER_METADATA_PATH) {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    }
    return jsonResponse(authorizationServerMetadata(config, oauth), 200, {
      'Cache-Control': 'public, max-age=300',
    });
  }
  if (oauth.kind === 'ready') {
    const response = await handleOAuthRequest(request, pathname, oauth.deps);
    if (response !== null) return response;
  }
  return jsonResponse({ error: 'not_found' }, 404);
}
