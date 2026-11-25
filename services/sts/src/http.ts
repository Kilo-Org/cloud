import { withDORetry } from '@kilocode/worker-utils';
import {
  BundleRequestSchema,
  STS_BUNDLE_HTTP_PATH,
  STS_FETCHED_AT_HEADER,
  STS_STALE_HEADER,
  bundleResultHttpStatus,
  type BundleRequest,
  type BundleResult,
} from '@kilocode/sts-contracts';
import { serveBundle } from './broker';
import { VERIFIER_RETRY_AFTER_SECONDS, WEBHOOK_MAX_BODY_BYTES } from './constants';
import { getRefresherStub, getSignerStub } from './dos/stubs';
import type { ManagerJwks } from './dos/SignerDO';
import { MANAGER_JWKS_PATH, readConfig, type Env, type StsConfig } from './env';
import { IdentityVerifier } from './identity/verify';
import { policyIndex } from './policy';

/** Infisical posts `secrets.modified` for this environment here (README). */
export const MANAGER_WEBHOOK_PATH = '/manager-webhook';

/** The key set changes only when the signer key does, so an isolate serves it from memory. */
const JWKS_CACHE_MS = 5 * 60 * 1000;

let jwksCache: { environment: string; jwks: ManagerJwks; expiresAt: number } | null = null;

/** Provider discovery and key sets are cached in the verifier, so one instance serves the isolate. */
let verifierCache: { key: string; instance: IdentityVerifier } | null = null;

function jsonResponse(body: unknown, status: number, cacheControl: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': cacheControl },
  });
}

/** Maps a bundle result to its HTTP response; exported for the response-shape tests. */
export function bundleResponse(result: BundleResult): Response {
  const status = bundleResultHttpStatus(result);
  const headers = new Headers({ 'cache-control': 'no-store' });
  if (result.status === 'ok' || result.status === 'not_modified') {
    headers.set('etag', result.etag);
    headers.set(STS_STALE_HEADER, String(result.stale));
    headers.set(STS_FETCHED_AT_HEADER, result.fetchedAt);
  }
  if (result.status === 'unavailable') {
    headers.set('retry-after', String(result.retryAfterSeconds));
  }
  if (result.status === 'not_modified') return new Response(null, { status, headers });
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(result), { status, headers });
}

function identityVerifier(config: StsConfig): IdentityVerifier {
  const key = `${config.issuer}|${config.environment}`;
  const cached = verifierCache;
  if (cached !== null && cached.key === key) return cached.instance;
  const instance = new IdentityVerifier({
    policies: policyIndex.all(),
    environment: config.environment,
    issuer: config.issuer,
    fetch: (input, init) => fetch(input, init),
  });
  verifierCache = { key, instance };
  return instance;
}

async function readBundleRequest(request: Request): Promise<BundleRequest | null> {
  const text = await request.text();
  if (text.trim() === '') return {};
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = BundleRequestSchema.safeParse(document);
  return parsed.success ? parsed.data : null;
}

async function keySet(env: Env, config: StsConfig): Promise<Response> {
  const now = Date.now();
  const cached = jwksCache;
  let jwks: ManagerJwks;
  if (cached !== null && cached.environment === config.environment && cached.expiresAt > now) {
    jwks = cached.jwks;
  } else {
    jwks = await withDORetry(
      () => getSignerStub(env, config),
      stub => stub.getJwks(),
      'sts.getJwks'
    );
    jwksCache = { environment: config.environment, jwks, expiresAt: now + JWKS_CACHE_MS };
  }
  return jsonResponse(jwks, 200, 'public, max-age=300');
}

async function bundleRequest(request: Request, env: Env, config: StsConfig): Promise<Response> {
  const authorization = request.headers.get('authorization');
  const token = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';
  if (token.length === 0) {
    return bundleResponse({ status: 'denied', reason: 'identity_rejected' });
  }

  const outcome = await identityVerifier(config).verify(token);
  if (outcome.status === 'unavailable') {
    return bundleResponse({
      status: 'unavailable',
      reason: 'internal',
      retryAfterSeconds: VERIFIER_RETRY_AFTER_SECONDS,
    });
  }
  if (outcome.status === 'denied') {
    return bundleResponse({ status: 'denied', reason: outcome.reason });
  }

  const body = await readBundleRequest(request);
  if (body === null) return jsonResponse({ error: 'invalid_request' }, 400, 'no-store');
  return bundleResponse(await serveBundle(env, config, outcome.workload, body));
}

/**
 * Only a signed body reaches the refresher. The size and header shape are checked here, so an
 * unsigned flood costs no Durable Object hop.
 */
async function managerWebhook(request: Request, env: Env, config: StsConfig): Promise<Response> {
  const signature = request.headers.get('x-infisical-signature');
  if (signature === null || !/^t=\d{1,16};[0-9a-f]{64}$/.test(signature)) {
    return jsonResponse({ error: 'invalid_signature' }, 401, 'no-store');
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > WEBHOOK_MAX_BODY_BYTES) {
    return jsonResponse({ error: 'too_large' }, 413, 'no-store');
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > WEBHOOK_MAX_BODY_BYTES) {
    return jsonResponse({ error: 'too_large' }, 413, 'no-store');
  }
  const outcome = await withDORetry(
    () => getRefresherStub(env, config),
    async stub => await stub.receiveWebhook(body, signature),
    'sts.receiveWebhook'
  );
  if (outcome.status === 'rejected') {
    return jsonResponse({ error: 'invalid_signature' }, 401, 'no-store');
  }
  return jsonResponse({ status: outcome.status }, 200, 'no-store');
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const config = readConfig(env);
  const { pathname } = new URL(request.url);

  if (request.method === 'GET' && pathname === MANAGER_JWKS_PATH) {
    return await keySet(env, config);
  }
  if (request.method === 'POST' && pathname === STS_BUNDLE_HTTP_PATH) {
    return await bundleRequest(request, env, config);
  }
  if (request.method === 'POST' && pathname === MANAGER_WEBHOOK_PATH) {
    return await managerWebhook(request, env, config);
  }
  return new Response('not found', { status: 404 });
}
