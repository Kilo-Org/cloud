import {
  encodeBase64Url,
  FeedListHashSchema,
  UTS_BOOTSTRAP_PATH,
  UTS_FEED_HEAD_AGE_HEADER,
  UTS_FEED_HEAD_PATH,
  UTS_FEED_LIST_PATH_PREFIX,
  UTS_JWKS_MAX_AGE_SECONDS,
  UTS_JWKS_OLDEST_AGE_HEADER,
  UTS_JWKS_PATH,
  UTS_JWKS_STALE_IF_ERROR_SECONDS,
  UTS_SIGNER_KEYS_HOLD_MS,
  type UtsBootstrapWire,
} from '@kilocode/uts-contracts';
import { serveBootstrap } from './bootstrap';
import { readConfig, type Env, type FeedConfig } from './env';
import { admitFeedRequest } from './https-auth';
import { KEY_SET_READ_GUARD_MS, serveKeySet } from './jwks';
import {
  FEED_LIST_CACHE_SECONDS,
  FEED_RETRY_AFTER_SECONDS,
  serveHead,
  serveList,
} from './revocation';

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
 * gives the 5-minute lifetime from the last fresh keys, so one failing signer does not expire the
 * set; the oldest age gives the verifier's 24-hour last-good limit (design 5.7, 7). A standard HTTP
 * cache reads only `Age` and `Cache-Control`: it serves the response fresh until `max-age` minus
 * `Age` after it arrived, and on error for `stale-if-error` more (RFC 5861). So both limits are cut
 * to end, from arrival, no later than the oldest keys' hold, counted down to whole seconds; no
 * cache can then keep a key past 24 hours after its last good read.
 */
function keySetHeaders(ageMs: number, oldestAgeMs: number): Record<string, string> {
  const age = Math.floor(ageMs / 1000);
  const holdLeft = Math.floor((UTS_SIGNER_KEYS_HOLD_MS - oldestAgeMs) / 1000);
  const maxAge = Math.min(UTS_JWKS_MAX_AGE_SECONDS, age + holdLeft);
  const staleIfError = Math.min(UTS_JWKS_STALE_IF_ERROR_SECONDS, holdLeft - (maxAge - age));
  return {
    'Content-Type': 'application/json',
    'Cache-Control': `max-age=${maxAge}, stale-if-error=${staleIfError}`,
    Age: String(age),
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

/**
 * The revocation feed over HTTPS, for Vercel and Fly verifiers (design 5.6), in every environment
 * behind the switch and the caller check of `src/https-auth.ts`. The answers carry the feed's
 * names, so a shared cache keeps none (`private`); the caller's own cache may revalidate:
 *
 * - head: `no-cache` with a weak `ETag` of the head's time and list hash; an `If-None-Match` that
 *   matches answers 304 with no body. Two feed objects can sign the same time and list under
 *   different keys; either head says the same, so the tag is weak (RFC 9110 section 8.8.1).
 * - list: named by its hash, so it never changes: `max-age=600, immutable` and the hash as a
 *   strong `ETag`; a matching `If-None-Match` answers 304 without reading a feed object.
 * - bootstrap: `no-store`; it runs once per cold verifier.
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

const NO_STORE = { 'Cache-Control': 'no-store' };
const HEAD_CACHE = { 'Cache-Control': 'private, no-cache' };
const LIST_CACHE = { 'Cache-Control': `private, max-age=${FEED_LIST_CACHE_SECONDS}, immutable` };

/**
 * Whether `If-None-Match` names `etag`, by the weak comparison RFC 9110 section 13.1.2 prescribes
 * for it: `W/` is ignored on both sides, and `*` matches any current representation.
 */
function noneMatch(request: Request, etag: string): boolean {
  const header = request.headers.get('If-None-Match');
  if (header === null) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  return header.split(',').some(tag => tag.trim() === '*' || opaque(tag) === opaque(etag));
}

/** Whole seconds since a head's `iat`; 0 for a head up to 5 seconds ahead of this clock. */
function headAge(issuedAt: number): string {
  return String(Math.max(0, Math.floor(Date.now() / 1000) - issuedAt));
}

async function revocationFeed(
  route: FeedRoute,
  request: Request,
  env: Env,
  config: FeedConfig,
  ctx: ExecutionContext
): Promise<Response> {
  switch (route.kind) {
    case 'head': {
      const read = await serveHead(env.UTS_FEED_READS, config, ctx);
      if (read.status !== 'ok') return feedFailure(read.status);
      const etag = `W/"${read.issuedAt}-${read.listHash}"`;
      const headers = {
        ETag: etag,
        [UTS_FEED_HEAD_AGE_HEADER]: headAge(read.issuedAt),
        ...HEAD_CACHE,
      };
      if (noneMatch(request, etag)) return new Response(null, { status: 304, headers });
      return new Response(read.head, {
        headers: { 'Content-Type': 'application/jwt', ...headers },
      });
    }
    case 'list': {
      const etag = `"${route.hash}"`;
      // The client holds exactly the bytes this hash names, so nothing needs reading.
      if (FeedListHashSchema.safeParse(route.hash).success && noneMatch(request, etag)) {
        return new Response(null, { status: 304, headers: { ETag: etag, ...LIST_CACHE } });
      }
      const read = await serveList(env.UTS_FEED_READS, config, route.hash, ctx);
      if (read.status === 'not_found') return errorResponse('not_found', 404);
      if (read.status !== 'ok') return feedFailure(read.status);
      return new Response(read.bytes, {
        headers: { 'Content-Type': 'application/json', ETag: etag, ...LIST_CACHE },
      });
    }
    case 'bootstrap': {
      const read = await serveBootstrap(env, config, ctx);
      if (read.status !== 'ok') return feedFailure(read.status);
      const body: UtsBootstrapWire = {
        jwks: read.jwks,
        key_ages: read.keyAges,
        head: read.head,
        list: encodeBase64Url(read.list),
      };
      // The same ages as the key-set response's headers, so either reader counts them.
      return Response.json(body, {
        headers: {
          ...NO_STORE,
          Age: String(read.keyAges.newest),
          [UTS_JWKS_OLDEST_AGE_HEADER]: String(read.keyAges.oldest),
          [UTS_FEED_HEAD_AGE_HEADER]: headAge(read.headIssuedAt),
        },
      });
    }
  }
}

/**
 * The key set is public. The feed paths answer 503 with `Retry-After` while the switch is off or
 * no STS issuer is set, then 401 or 403 without a valid STS token of an admitted workload; only an
 * admitted request reads the feed.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route = feedRoute(pathname);
  if (pathname !== UTS_JWKS_PATH && route === null) return errorResponse('not_found', 404);
  if (request.method !== 'GET') return errorResponse('method_not_allowed', 405, { Allow: 'GET' });
  if (route === null) return await keySet(env, ctx);
  const config = readConfig(env);
  const admission = await admitFeedRequest(request, config, ctx);
  if (admission.status !== 'admitted') return admission.response;
  return await revocationFeed(route, request, env, config, ctx);
}
