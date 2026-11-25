import { UTS_AUTHORIZATION_SERVER_METADATA_PATH } from '@kilocode/uts-contracts';
import { readConfig, type Env } from './env';
import { authorizationServerMetadata } from './metadata/authorization-server';
import { jsonResponse } from './responses';

/**
 * The mint Worker's fetch handler. Placement runs it next to the identity store's primary, which
 * applies to fetch handlers only, not to RPC methods (design 5.2). Today it serves the issuer
 * metadata; the authorization and token endpoints join here.
 */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const config = readConfig(env);
  const { pathname } = new URL(request.url);
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
