import { UTS_JWKS_CACHE_CONTROL, UTS_JWKS_PATH } from '@kilocode/uts-contracts';
import { readConfig, type Env } from './env';
import { KEY_SET_READ_GUARD_MS, serveKeySet } from './jwks';

function errorResponse(
  error: string,
  status: number,
  headers: Record<string, string> = {}
): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

async function keySet(env: Env, ctx: ExecutionContext): Promise<Response> {
  const config = readConfig(env);
  const read = await serveKeySet(env.UTS_MINT, config.environment, ctx);
  switch (read.status) {
    case 'ok':
      return new Response(read.body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': UTS_JWKS_CACHE_CONTROL },
      });
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
