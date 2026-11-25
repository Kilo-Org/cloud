import { UTS_JWKS_CACHE_CONTROL, UTS_JWKS_PATH } from '@kilocode/uts-contracts';
import { readConfig, type Env } from './env';
import { readKeySet } from './jwks';

/** A failed read is retried on the next request; a verifier keeps its last good set meanwhile. */
const UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

function errorResponse(
  error: string,
  status: number,
  headers: Record<string, string> = {}
): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

async function keySet(env: Env): Promise<Response> {
  const config = readConfig(env);
  const read = await readKeySet(env.UTS_SIGNER_KEYS, config.environment, Date.now());
  switch (read.status) {
    case 'ok':
      return new Response(read.body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': UTS_JWKS_CACHE_CONTROL },
      });
    case 'unavailable':
      return errorResponse('temporarily_unavailable', 503, {
        'Retry-After': String(UNAVAILABLE_RETRY_AFTER_SECONDS),
      });
    case 'misconfigured':
      return errorResponse('server_error', 500);
  }
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname !== UTS_JWKS_PATH) return errorResponse('not_found', 404);
  if (request.method !== 'GET') return errorResponse('method_not_allowed', 405, { Allow: 'GET' });
  return await keySet(env);
}
