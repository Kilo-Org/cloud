import {
  UTS_AUTHORIZATION_SERVER_METADATA_PATH,
  UTS_SIGNER_KEYS_PATH,
} from '@kilocode/uts-contracts';
import { readConfig, type Env } from './env';
import { authorizationServerMetadata } from './metadata/authorization-server';
import { jsonResponse } from './responses';
import { signerKeysResponse } from './signer-keys';

/**
 * The mint Worker's fetch handler. Placement runs it next to the identity store's primary, which
 * applies to fetch handlers only, not to RPC methods or named entrypoints (design 5.2). It serves
 * the issuer metadata and the feed Worker's internal signer-keys read; the authorization and token
 * endpoints join here.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const config = readConfig(env);
  const { pathname } = new URL(request.url);
  if (pathname === UTS_SIGNER_KEYS_PATH) {
    return await signerKeysResponse(request, env, config, ctx.props);
  }
  if (pathname === UTS_AUTHORIZATION_SERVER_METADATA_PATH) {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    }
    return jsonResponse(authorizationServerMetadata(config), 200, {
      'Cache-Control': 'public, max-age=300',
    });
  }
  return jsonResponse({ error: 'not_found' }, 404);
}
