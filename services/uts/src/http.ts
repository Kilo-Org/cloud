import {
  UTS_AUTHORIZATION_SERVER_METADATA_PATH,
  UTS_SIGNER_KEYS_PATH,
} from '@kilocode/uts-contracts';
import { readConfig, type Env } from './env';
import { authorizationServerMetadata } from './metadata/authorization-server';
import type { AuthorizationHandoff } from './oauth/authorize';
import { handleOAuthRequest, oauthService } from './oauth/routes';
import { jsonResponse } from './responses';
import { signerKeysResponse } from './signer-keys';

/** What only the development entry adds: the development sign-in hand-off (src/dev.ts). */
export type MintOptions = { authorizationHandoff: AuthorizationHandoff | null };

const DEPLOYED: MintOptions = { authorizationHandoff: null };

/**
 * The mint Worker's fetch handler. Placement runs it next to the identity store's primary, which
 * applies to fetch handlers only, not to RPC methods or named entrypoints (design 5.2). It serves
 * the issuer metadata, the feed Worker's internal signer-keys read, and the OAuth endpoints once
 * the identity store is bound (src/oauth/routes.ts).
 */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: MintOptions = DEPLOYED
): Promise<Response> {
  const config = readConfig(env);
  const { pathname } = new URL(request.url);
  if (pathname === UTS_SIGNER_KEYS_PATH) {
    return await signerKeysResponse(request, env, config, ctx.props);
  }
  const oauth = oauthService(env, ctx, config, options.authorizationHandoff);
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
