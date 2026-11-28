import { withDORetry } from '@kilocode/worker-utils';
import {
  BundleRequestSchema,
  JWKS_PATH,
  STS_BUNDLE_HTTP_PATH,
  STS_CLOUDFLARE_DEPLOY_TOKEN_HTTP_PATH,
  STS_CLOUDFLARE_DEPLOY_TOKEN_REVOKE_HTTP_PATH,
  STS_FETCHED_AT_HEADER,
  STS_STALE_HEADER,
  bundleResultHttpStatus,
  cloudflareDeployTokenResultHttpStatus,
  cloudflareDeployTokenRevokeResultHttpStatus,
  mintResultHttpStatus,
  type BundleRequest,
  type BundleResult,
  type CloudflareDeployTokenResult,
  type CloudflareDeployTokenRevokeResult,
  type MintResult,
} from '@kilocode/sts-contracts';
import { recordDenial } from './audit/denials';
import { serveBundle } from './broker';
import {
  BUNDLE_REQUEST_MAX_BODY_BYTES,
  DEPLOY_TOKEN_REQUEST_MAX_BODY_BYTES,
  TOKEN_JWKS_CACHE_MS,
  TOKEN_KEY_SET_DEADLINE_MS,
  TOKEN_REQUEST_MAX_BODY_BYTES,
  VERIFIER_RETRY_AFTER_SECONDS,
  WEBHOOK_MAX_BODY_BYTES,
} from './constants';
import {
  recordDeployTokenDenial,
  serveDeployToken,
  serveDeployTokenRevoke,
} from './deploy-tokens/serve';
import { getRefresherStub, getSignerStub, getTokenKeySetStub } from './dos/stubs';
import type { ManagerJwks } from './dos/SignerDO';
import type { TokenKeySetRead } from './dos/TokenKeySetDO';
import { MANAGER_JWKS_PATH, readConfig, type Env, type StsConfig } from './env';
import {
  IdentityVerifier,
  type DeniedReason,
  type GithubRun,
  type IdentityProvider,
} from './identity/verify';
import { WebhookGate, type WebhookOutcome } from './infisical/webhook';
import { holdsMigrationRun } from './policy/schema';
import type { PolicyIndex } from './policy/load';
import { callWithDeadline } from './rpc';
import {
  defaultMintAuthority,
  serveMint,
  type MintAuthority,
  type MintCaller,
} from './tokens/mint';
import type { TokenJwk } from './tokens/key-ring';

/** Infisical posts `secrets.modified` for this environment here (README). */
export const MANAGER_WEBHOOK_PATH = '/manager-webhook';

/** A caller outside the account posts a mint request here with its provider OIDC token. */
export const TOKEN_HTTP_PATH = '/v1/token';

/** The key set changes only when the signer key does, so an isolate serves it from memory. */
const JWKS_CACHE_MS = 5 * 60 * 1000;

/**
 * Plain data only, never a promise: workerd ties a promise to the request that created it, so a
 * request awaiting another request's pending call stalls when that request ends first.
 */
let jwksCache: { environment: string; jwks: ManagerJwks; expiresAt: number } | null = null;

/**
 * The service-token key set, plain data as above, with the revoked-kid list it was built under: a
 * change of that list (an emergency removal) rebuilds it, so the replacement keys show at once.
 */
let tokenJwksCache: {
  environment: string;
  revokedKids: string;
  keys: TokenJwk[];
  expiresAt: number;
} | null = null;

let gateCache: { environment: string; gate: WebhookGate } | null = null;

/**
 * Provider discovery and key sets are cached in the verifier, so one instance serves the isolate.
 * A trigger-only policy (`migration-run`) is left out: its job's token opens no route here, only
 * `attestGithubRun` with the migration proxy's audience.
 */
let verifierCache: { key: string; policies: PolicyIndex; instance: IdentityVerifier } | null = null;

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

function identityVerifier(config: StsConfig, policies: PolicyIndex): IdentityVerifier {
  const key = `${config.issuer}|${config.environment}`;
  const cached = verifierCache;
  if (cached !== null && cached.key === key && cached.policies === policies) {
    return cached.instance;
  }
  const instance = new IdentityVerifier({
    policies: policies.all().filter(policy => !holdsMigrationRun(policy)),
    environment: config.environment,
    audience: config.issuer,
    fetch: (input, init) => fetch(input, init),
  });
  verifierCache = { key, policies, instance };
  return instance;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
}

/** Maps a mint result to its HTTP response; exported for the response-shape tests. */
export function mintResponse(result: MintResult): Response {
  const headers = new Headers({ 'cache-control': 'no-store', 'content-type': 'application/json' });
  if (result.status === 'unavailable') {
    headers.set('retry-after', String(result.retryAfterSeconds));
  }
  return new Response(JSON.stringify(result), { status: mintResultHttpStatus(result), headers });
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
  // Partial: only a workerd RPC result carries a disposer (see serveBundle in broker.ts).
  const fetched: ManagerJwks & Partial<Disposable> = await withDORetry(
    () => getSignerStub(env, config),
    stub => stub.getJwks(),
    'sts.getJwks'
  );
  // A plain copy (nested values are plain data after structured clone), then the result's disposer.
  const jwks: ManagerJwks = { keys: fetched.keys };
  fetched[Symbol.dispose]?.();
  jwksCache = { environment: config.environment, jwks, expiresAt: Date.now() + JWKS_CACHE_MS };
  return jsonResponse(jwks, 200, 'public, max-age=300');
}

/**
 * The service-token key set (design 5.7): the next, current and retired-in-grace keys of every
 * token signer shard. A request that finds no fresh isolate copy makes ONE call, to the key-set
 * object (`TokenKeySetDO`), which holds the shards' keys as one document; the copy then serves
 * until `TOKEN_JWKS_CACHE_MS` after the shard reads that built that document, not after this
 * call, so the object's document and this copy together are never older than one period.
 * Requests that find the copy stale at the same moment each make the call (no promise is shared
 * across requests). A kid listed in `TOKEN_SIGNING_KIDS_REVOKED` is left out here as well as in
 * the signer, so an emergency removal never waits on an object, and a change of that list
 * rebuilds the copy and the object's document. The answer is `no-store`: a key-set removal is the
 * only recall of an STS token (design Q50), so no HTTP cache may hold the set, nor serve it stale
 * while STS answers 503; only the verifier's own 5-minute copy counts. A scheduled removal (a
 * retired key leaving the ring) can therefore reach verifiers up to 10 minutes later: up to 5
 * minutes from the shard read in the object's document and this copy, then up to 5 in the
 * verifier's. An emergency removal is filtered from every answer, so it reaches them within the
 * verifier's 5 minutes.
 */
async function tokenKeySet(env: Env, config: StsConfig): Promise<Response> {
  const cached = tokenJwksCache;
  const revokedKids = config.revokedTokenKids.join(',');
  let keys: TokenJwk[];
  if (
    cached !== null &&
    cached.environment === config.environment &&
    cached.revokedKids === revokedKids &&
    cached.expiresAt > Date.now()
  ) {
    keys = cached.keys;
  } else {
    const outcome = await callWithDeadline(
      async (): Promise<TokenKeySetRead> =>
        await withDORetry(
          () => getTokenKeySetStub(env, config),
          async (stub): Promise<TokenKeySetRead> => await stub.read(config.revokedTokenKids),
          'sts.readTokenKeySet'
        ),
      TOKEN_KEY_SET_DEADLINE_MS
    );
    if (outcome.status !== 'answered' || outcome.value.status !== 'ok') {
      console.warn('sts: token key set could not be loaded', {
        outcome: outcome.status === 'answered' ? outcome.value.status : outcome.status,
        reason:
          outcome.status === 'failed' && outcome.error instanceof Error
            ? outcome.error.name
            : 'none',
      });
      return unavailableResponse();
    }
    const { builtAt } = outcome.value;
    keys = outcome.value.keys.map(key => ({ ...key }));
    tokenJwksCache = {
      environment: config.environment,
      revokedKids,
      keys,
      // On a clock behind the object's, the copy still expires one period after this call at most.
      expiresAt: Math.min(builtAt, Date.now()) + TOKEN_JWKS_CACHE_MS,
    };
  }
  return jsonResponse(
    { keys: keys.filter(key => !config.revokedTokenKids.includes(key.kid)) },
    200,
    'no-store'
  );
}

/**
 * `POST /v1/token`: a provider OIDC token in `Authorization`, a mint request as the body. A token
 * that did not verify is refused and only logged. A verified identity the verifier refused (its
 * binding failed, its policy is for another environment, or no policy here names it) is refused
 * whole and audited as one token denial with the verifier's own reason; its name never reaches
 * the policy check. The body is read only after the token verified.
 */
async function tokenRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: StsConfig,
  authority: MintAuthority
): Promise<Response> {
  const token = bearerToken(request);
  if (token.length === 0) return mintResponse({ status: 'identity_rejected' });

  const outcome = await identityVerifier(config, authority.policies).verify(token);
  if (outcome.status === 'unavailable') {
    return mintResponse({ status: 'unavailable', retryAfterSeconds: VERIFIER_RETRY_AFTER_SECONDS });
  }
  if (outcome.status === 'denied') {
    const { subject } = outcome;
    if (subject === undefined) {
      console.warn('sts: token request refused: token not verified', {
        environment: config.environment,
        reason: outcome.reason,
      });
    } else {
      const hop = recordDenial(env, config, {
        kind: 'token',
        channel: 'http',
        reason: outcome.reason,
        actor: subject.actor,
        claims: { provider: subject.provider, ...subject.claims },
      });
      if (hop !== null) ctx.waitUntil(hop);
    }
    return mintResponse({ status: 'identity_rejected' });
  }
  const caller: MintCaller = {
    channel: 'http',
    workload: outcome.workload,
    identity: outcome.provider,
    attestationExp: outcome.attestationExp,
    claims: { provider: outcome.provider },
  };

  const text = await readCappedText(request, TOKEN_REQUEST_MAX_BODY_BYTES);
  if (text === null) {
    return new Response(JSON.stringify({ status: 'invalid_request' } satisfies MintResult), {
      status: 413,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return mintResponse({ status: 'invalid_request' });
  }
  return mintResponse(
    await serveMint(env, config, {
      caller,
      request: body,
      waitUntil: promise => ctx.waitUntil(promise),
      authority,
    })
  );
}

async function bundleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: StsConfig,
  authority: MintAuthority
): Promise<Response> {
  const token = bearerToken(request);
  if (token.length === 0) {
    return bundleResponse({ status: 'denied', reason: 'identity_rejected' });
  }

  const outcome = await identityVerifier(config, authority.policies).verify(token);
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
  return bundleResponse(
    await serveBundle(env, config, outcome.workload, body.value, { run: outcome.run })
  );
}

/** Maps a deploy-token answer to its HTTP response; exported for the response-shape tests. */
export function deployTokenResponse(result: CloudflareDeployTokenResult): Response {
  return noStoreJson(result, cloudflareDeployTokenResultHttpStatus(result));
}

/** Maps a deploy-token revoke answer to its HTTP response. */
export function deployTokenRevokeResponse(result: CloudflareDeployTokenRevokeResult): Response {
  return noStoreJson(result, cloudflareDeployTokenRevokeResultHttpStatus(result));
}

function noStoreJson(result: object, status: number): Response {
  const headers = new Headers({ 'cache-control': 'no-store', 'content-type': 'application/json' });
  if ('retryAfterSeconds' in result) headers.set('retry-after', String(result.retryAfterSeconds));
  return new Response(JSON.stringify(result), { status, headers });
}

/** The answers the deploy-token routes give before their own logic runs. */
type CallerRefusal =
  | { status: 'denied'; reason: DeniedReason }
  | { status: 'unavailable'; retryAfterSeconds: number }
  | { status: 'invalid_request' };

/** A caller whose provider token verified and named a policy. */
type VerifiedHttpCaller = {
  workload: string;
  provider: IdentityProvider;
  run: GithubRun | null;
  claims: Record<string, string>;
};

/**
 * `POST /v1/ci/cloudflare-deploy-token` and its `/revoke`: a provider OIDC token in `Authorization`
 * (a GitHub deploy job), a JSON body. As on `/v1/token`, a token that did not verify is refused
 * and only logged, a verified identity the verifier refused is audited as a denial of the route's
 * kind with the verifier's reason, and the body (at most `maxBodyBytes`) is read only after the
 * token verified. The deploy-token mint takes an empty body as `{}`.
 */
async function oidcRoute<Result>(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: StsConfig,
  policies: PolicyIndex,
  route: {
    route: string;
    maxBodyBytes: number;
    emptyBodyIsObject: boolean;
    denyIdentity: (
      subject: { workload: string; claims: Record<string, string> },
      reason: DeniedReason,
      waitUntil: (promise: Promise<unknown>) => void
    ) => void;
    serve: (
      caller: VerifiedHttpCaller,
      body: unknown,
      waitUntil: (promise: Promise<unknown>) => void
    ) => Promise<Result>;
    respond: (result: Result | CallerRefusal) => Response;
  }
): Promise<Response> {
  const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);
  const { respond } = route;
  const token = bearerToken(request);
  if (token.length === 0) return respond({ status: 'denied', reason: 'identity_rejected' });

  const outcome = await identityVerifier(config, policies).verify(token);
  if (outcome.status === 'unavailable') {
    return respond({ status: 'unavailable', retryAfterSeconds: VERIFIER_RETRY_AFTER_SECONDS });
  }
  if (outcome.status === 'denied') {
    const { subject } = outcome;
    if (subject === undefined) {
      console.warn(`sts: ${route.route} request refused: token not verified`, {
        environment: config.environment,
        reason: outcome.reason,
      });
    } else {
      route.denyIdentity(
        { workload: subject.actor, claims: { provider: subject.provider, ...subject.claims } },
        outcome.reason,
        waitUntil
      );
    }
    return respond({ status: 'denied', reason: outcome.reason });
  }
  const caller: VerifiedHttpCaller = {
    workload: outcome.workload,
    provider: outcome.provider,
    run: outcome.run,
    claims: { provider: outcome.provider },
  };

  const text = await readCappedText(request, route.maxBodyBytes);
  if (text === null) {
    return new Response(JSON.stringify({ status: 'invalid_request' }), {
      status: 413,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  let body: unknown;
  try {
    body = text === '' && route.emptyBodyIsObject ? {} : JSON.parse(text);
  } catch {
    return respond({ status: 'invalid_request' });
  }
  return respond(await route.serve(caller, body, waitUntil));
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

/**
 * Every HTTP route. `authority` (the policies and scope registry) is the shipped one in a
 * deployment; a test fixture passes its own.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  authority: MintAuthority = defaultMintAuthority
): Promise<Response> {
  const config = readConfig(env);
  const { pathname } = new URL(request.url);

  if (request.method === 'GET' && pathname === MANAGER_JWKS_PATH) {
    return await keySet(env, config);
  }
  if (request.method === 'GET' && pathname === JWKS_PATH) {
    return await tokenKeySet(env, config);
  }
  if (request.method === 'POST' && pathname === TOKEN_HTTP_PATH) {
    return await tokenRequest(request, env, ctx, config, authority);
  }
  if (request.method === 'POST' && pathname === STS_BUNDLE_HTTP_PATH) {
    return await bundleRequest(request, env, ctx, config, authority);
  }
  if (request.method === 'POST' && pathname === STS_CLOUDFLARE_DEPLOY_TOKEN_HTTP_PATH) {
    const { policies } = authority;
    return await oidcRoute<CloudflareDeployTokenResult>(request, env, ctx, config, policies, {
      route: 'deploy token',
      maxBodyBytes: DEPLOY_TOKEN_REQUEST_MAX_BODY_BYTES,
      emptyBodyIsObject: true,
      denyIdentity: (subject, reason, waitUntil) =>
        recordDeployTokenDenial(env, config, subject, waitUntil, reason),
      serve: (caller, body, waitUntil) =>
        serveDeployToken(env, config, {
          caller: { ...caller, identity: caller.provider },
          request: body,
          policies,
          waitUntil,
        }),
      respond: deployTokenResponse,
    });
  }
  if (request.method === 'POST' && pathname === STS_CLOUDFLARE_DEPLOY_TOKEN_REVOKE_HTTP_PATH) {
    return await oidcRoute<CloudflareDeployTokenRevokeResult>(
      request,
      env,
      ctx,
      config,
      authority.policies,
      {
        route: 'deploy token revoke',
        maxBodyBytes: DEPLOY_TOKEN_REQUEST_MAX_BODY_BYTES,
        emptyBodyIsObject: false,
        denyIdentity: (subject, reason, waitUntil) =>
          recordDeployTokenDenial(env, config, subject, waitUntil, reason),
        serve: (caller, body, waitUntil) =>
          serveDeployTokenRevoke(env, config, {
            caller: { ...caller, identity: caller.provider },
            request: body,
            waitUntil,
          }),
        respond: deployTokenRevokeResponse,
      }
    );
  }
  if (request.method === 'POST' && pathname === MANAGER_WEBHOOK_PATH) {
    return await managerWebhook(request, env, config);
  }
  return new Response('not found', { status: 404 });
}
