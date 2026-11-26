import {
  encodeBase64Url,
  UTS_BOOTSTRAP_PATH,
  UTS_FEED_HEAD_PATH,
  UTS_FEED_LIST_PATH_PREFIX,
  UTS_JWKS_CACHE_CONTROL,
  UTS_JWKS_OLDEST_AGE_HEADER,
  UTS_JWKS_PATH,
  type UtsBootstrapWire,
} from '@kilocode/uts-contracts';
import { serveBootstrap } from './bootstrap';
import { readConfig, type Env, type FeedConfig } from './env';
import { KEY_SET_READ_GUARD_MS, serveKeySet } from './jwks';
import { FEED_RETRY_AFTER_SECONDS, serveHead, serveList } from './revocation';

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

/** The answer for a feed read that failed: 503 to retry after a backfill, 500 for a deploy error. */
function feedFailure(status: 'unavailable' | 'misconfigured'): Response {
  return status === 'misconfigured'
    ? errorResponse('server_error', 500)
    : errorResponse('temporarily_unavailable', 503, {
        'Retry-After': String(FEED_RETRY_AFTER_SECONDS),
      });
}

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * The revocation feed over HTTPS, for Vercel and Fly verifiers (design 5.6). The feed names
 * accounts and grants, so it answers only callers with a verified workload identity, and that
 * check verifies STS audience tokens with `@kilocode/verify` (phase 2, decision Q7). Until the feed
 * Worker carries it, staging and production answer these paths 404 and serve the feed over
 * service bindings only (`FeedReader`); development serves them to the local end-to-end run.
 */
type FeedRoute = { kind: 'head' } | { kind: 'list'; hash: string } | { kind: 'bootstrap' };

function feedRoute(pathname: string): FeedRoute | null {
  if (pathname === UTS_FEED_HEAD_PATH) return { kind: 'head' };
  if (pathname === UTS_BOOTSTRAP_PATH) return { kind: 'bootstrap' };
  if (pathname.startsWith(UTS_FEED_LIST_PATH_PREFIX)) {
    return { kind: 'list', hash: pathname.slice(UTS_FEED_LIST_PATH_PREFIX.length) };
  }
  return null;
}

async function revocationFeed(
  route: FeedRoute,
  env: Env,
  config: FeedConfig,
  ctx: ExecutionContext
): Promise<Response> {
  switch (route.kind) {
    case 'head': {
      const read = await serveHead(env.UTS_FEED_READS, config, ctx);
      if (read.status !== 'ok') return feedFailure(read.status);
      return new Response(read.head, {
        headers: { 'Content-Type': 'application/jwt', ...NO_STORE },
      });
    }
    case 'list': {
      const read = await serveList(env.UTS_FEED_READS, config, route.hash, ctx);
      if (read.status === 'not_found') return errorResponse('not_found', 404);
      if (read.status !== 'ok') return feedFailure(read.status);
      return new Response(read.bytes, {
        headers: { 'Content-Type': 'application/json', ...NO_STORE },
      });
    }
    case 'bootstrap': {
      const read = await serveBootstrap(env, config, ctx);
      if (read.status !== 'ok') return feedFailure(read.status);
      const body: UtsBootstrapWire = {
        jwks: read.jwks,
        head: read.head,
        list: encodeBase64Url(read.list),
      };
      return Response.json(body, { headers: NO_STORE });
    }
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const config = readConfig(env);
  const route = config.environment === 'development' ? feedRoute(pathname) : null;
  if (pathname !== UTS_JWKS_PATH && route === null) return errorResponse('not_found', 404);
  if (request.method !== 'GET') return errorResponse('method_not_allowed', 405, { Allow: 'GET' });
  if (route === null) return await keySet(env, ctx);
  return await revocationFeed(route, env, config, ctx);
}
