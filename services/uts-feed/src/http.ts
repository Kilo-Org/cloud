import {
  UTS_JWKS_CACHE_CONTROL,
  UTS_JWKS_OLDEST_AGE_HEADER,
  UTS_JWKS_PATH,
} from '@kilocode/uts-contracts';
import { readConfig, type Env } from './env';
import { KEY_SET_READ_GUARD_MS, serveKeySet } from './jwks';

function errorResponse(
  error: string,
  status: number,
  headers: Record<string, string> = {}
): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

/**
 * Headers for a key set whose newest keys were read from their signer objects `ageMs` ago and
 * whose oldest keys `oldestAgeMs` ago, both sent in whole seconds. `Age` (RFC 9111 section 5.1)
 * beside the unchanged cache limits gives the 5-minute lifetime from the last fresh keys, so one
 * failing signer does not expire the set; the oldest age gives the 24-hour last-good limit, so no
 * verifier keeps a key past 24 hours after its last good signer read (design 5.7, 7).
 */
function keySetHeaders(ageMs: number, oldestAgeMs: number): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': UTS_JWKS_CACHE_CONTROL,
    Age: String(Math.floor(ageMs / 1000)),
    [UTS_JWKS_OLDEST_AGE_HEADER]: String(Math.floor(oldestAgeMs / 1000)),
  };
}

async function keySet(env: Env, ctx: ExecutionContext): Promise<Response> {
  const config = readConfig(env);
  const read = await serveKeySet(env.UTS_MINT, config.environment, ctx);
  switch (read.status) {
    case 'ok':
      return new Response(read.body, { headers: keySetHeaders(read.ageMs, read.oldestAgeMs) });
    case 'unavailable':
      // Reached only when the isolate holds no usable set; the next read may start this late.
      return errorResponse('temporarily_unavailable', 503, {
        'Retry-After': String(KEY_SET_READ_GUARD_MS / 1000),
      });
    case 'misconfigured':
      return errorResponse('server_error', 500);
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname !== UTS_JWKS_PATH) return errorResponse('not_found', 404);
  if (request.method !== 'GET') return errorResponse('method_not_allowed', 405, { Allow: 'GET' });
  return await keySet(env, ctx);
}
