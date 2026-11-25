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
import { recordDenial } from './audit/denials';
import { serveBundle } from './broker';
import {
  BUNDLE_REQUEST_MAX_BODY_BYTES,
  VERIFIER_RETRY_AFTER_SECONDS,
  WEBHOOK_MAX_BODY_BYTES,
} from './constants';
import { getRefresherStub, getSignerStub } from './dos/stubs';
import type { ManagerJwks } from './dos/SignerDO';
import { MANAGER_JWKS_PATH, readConfig, type Env, type StsConfig } from './env';
import { IdentityVerifier } from './identity/verify';
import { WebhookGate, type WebhookOutcome } from './infisical/webhook';
import { policyIndex } from './policy';

/** Infisical posts `secrets.modified` for this environment here (README). */
export const MANAGER_WEBHOOK_PATH = '/manager-webhook';

/** The key set changes only when the signer key does, so an isolate serves it from memory. */
const JWKS_CACHE_MS = 5 * 60 * 1000;

/**
 * Plain data only, never a promise: workerd ties a promise to the request that created it, so a
 * request awaiting another request's pending call stalls when that request ends first.
 */
let jwksCache: { environment: string; jwks: ManagerJwks; expiresAt: number } | null = null;

let gateCache: { environment: string; gate: WebhookGate } | null = null;

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

/**
 * Reads a request body up to `limit` bytes and stops reading past it, so a chunked body with no
 * Content-Length cannot make the isolate buffer it. Returns null past the limit.
 */
export async function readCappedText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limit) {
    await request.body?.cancel();
    return null;
  }
  if (request.body === null) return '';
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  let tooLarge = false;
  try {
    await request.body.pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk: unknown) {
          if (!(chunk instanceof Uint8Array)) throw new TypeError('request body is not bytes');
          total += chunk.byteLength;
          if (total > limit) {
            tooLarge = true;
            throw new Error('request body above the limit');
          }
          text += decoder.decode(chunk, { stream: true });
        },
      })
    );
  } catch (error) {
    if (tooLarge) return null;
    throw error;
  }
  return text + decoder.decode();
}

type BodyRead =
  | { status: 'ok'; value: BundleRequest }
  | { status: 'invalid' }
  | { status: 'too_large' };

async function readBundleRequest(request: Request): Promise<BodyRead> {
  const text = await readCappedText(request, BUNDLE_REQUEST_MAX_BODY_BYTES);
  if (text === null) return { status: 'too_large' };
  if (text.trim() === '') return { status: 'ok', value: {} };
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { status: 'invalid' };
  }
  const parsed = BundleRequestSchema.safeParse(document);
  return parsed.success ? { status: 'ok', value: parsed.data } : { status: 'invalid' };
}

/**
 * A request that finds no fresh copy makes its own SignerDO call and stores the key set when it
 * lands; concurrent misses each make one call. A failed call is not cached.
 */
async function keySet(env: Env, config: StsConfig): Promise<Response> {
  const cached = jwksCache;
  if (
    cached !== null &&
    cached.environment === config.environment &&
    cached.expiresAt > Date.now()
  ) {
    return jsonResponse(cached.jwks, 200, 'public, max-age=300');
  }
  const fetched = await withDORetry(
    () => getSignerStub(env, config),
    stub => stub.getJwks(),
    'sts.getJwks'
  );
  const jwks: ManagerJwks = { keys: fetched.keys };
  jwksCache = { environment: config.environment, jwks, expiresAt: Date.now() + JWKS_CACHE_MS };
  return jsonResponse(jwks, 200, 'public, max-age=300');
}

async function bundleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: StsConfig
): Promise<Response> {
  const authorization = request.headers.get('authorization');
  const token = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';
  if (token.length === 0) {
    return bundleResponse({ status: 'denied', reason: 'identity_rejected' });
  }

  const outcome = await identityVerifier(config).verify(token);
  if (outcome.status === 'denied') {
    if (outcome.subject === undefined) {
      console.warn('sts: bundle request refused: token not verified', {
        environment: config.environment,
        reason: outcome.reason,
      });
    } else {
      const hop = recordDenial(env, config, {
        channel: 'http',
        reason: outcome.reason,
        actor: outcome.subject.actor,
        claims: { provider: outcome.subject.provider, ...outcome.subject.claims },
      });
      if (hop !== null) ctx.waitUntil(hop);
    }
  }
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
  if (body.status === 'too_large') return jsonResponse({ error: 'too_large' }, 413, 'no-store');
  if (body.status === 'invalid') return jsonResponse({ error: 'invalid_request' }, 400, 'no-store');
  return bundleResponse(await serveBundle(env, config, outcome.workload, body.value));
}

function webhookGate(env: Env, config: StsConfig): WebhookGate {
  const cached = gateCache;
  if (cached !== null && cached.environment === config.environment) return cached.gate;
  const gate = new WebhookGate({
    loadSecret: () =>
      withDORetry(
        () => getRefresherStub(env, config),
        stub => stub.webhookSecret(),
        'sts.webhookSecret'
      ),
    projectId: config.manager.projectId,
    environmentSlug: config.manager.environmentSlug,
    now: () => Date.now(),
  });
  gateCache = { environment: config.environment, gate };
  return gate;
}

/**
 * The Worker checks size and signature itself; only a verified `secrets.modified` for this
 * environment costs a refresher hop. Once the isolate holds the secret, a forged request costs at
 * most one secret reload per isolate per minute; before that, each request that finds no secret
 * loads it (WebhookGate).
 */
async function managerWebhook(request: Request, env: Env, config: StsConfig): Promise<Response> {
  const signature = request.headers.get('x-infisical-signature');
  if (signature === null || !/^t=\d{1,16};[0-9a-f]{64}$/.test(signature)) {
    return jsonResponse({ error: 'invalid_signature' }, 401, 'no-store');
  }
  const body = await readCappedText(request, WEBHOOK_MAX_BODY_BYTES);
  if (body === null) return jsonResponse({ error: 'too_large' }, 413, 'no-store');
  let outcome: WebhookOutcome;
  try {
    outcome = await webhookGate(env, config).verify(body, signature);
  } catch (error) {
    console.warn('sts: manager webhook secret could not be loaded', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return unavailableResponse();
  }
  if (outcome.status === 'rejected') {
    return jsonResponse({ error: 'invalid_signature' }, 401, 'no-store');
  }
  if (outcome.status === 'refresh') {
    try {
      await withDORetry(
        () => getRefresherStub(env, config),
        stub => stub.requestWebhookRefresh(),
        'sts.requestWebhookRefresh'
      );
    } catch (error) {
      console.warn('sts: manager webhook refresh request failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return unavailableResponse();
    }
  }
  return jsonResponse({ status: outcome.status }, 200, 'no-store');
}

function unavailableResponse(): Response {
  return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
    status: 503,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'retry-after': String(VERIFIER_RETRY_AFTER_SECONDS),
    },
  });
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const config = readConfig(env);
  const { pathname } = new URL(request.url);

  if (request.method === 'GET' && pathname === MANAGER_JWKS_PATH) {
    return await keySet(env, config);
  }
  if (request.method === 'POST' && pathname === STS_BUNDLE_HTTP_PATH) {
    return await bundleRequest(request, env, ctx, config);
  }
  if (request.method === 'POST' && pathname === MANAGER_WEBHOOK_PATH) {
    return await managerWebhook(request, env, config);
  }
  return new Response('not found', { status: 404 });
}
