import { withDORetry } from '@kilocode/worker-utils';
import {
  BundleRequestSchema,
  STS_BUNDLE_HTTP_PATH,
  bundleResultHttpStatus,
  type BundleRequest,
  type BundleResult,
} from '@kilocode/sts-contracts';
import { getSignerStub } from './dos/stubs';
import { readConfig, type Env, type StsConfig } from './env';
import { IdentityVerifier } from './identity/verify';
import { policyIndex } from './policy';
import { serveBundle } from './broker';

const MANAGER_AUTH_PATH = '/manager-auth';
const DISCOVERY_PATH = `${MANAGER_AUTH_PATH}/.well-known/openid-configuration`;
const JWKS_PATH = `${MANAGER_AUTH_PATH}/.well-known/jwks.json`;

function jsonResponse(body: unknown, status: number, cacheControl: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': cacheControl },
  });
}

function bundleResponse(result: BundleResult): Response {
  const status = bundleResultHttpStatus(result);
  const headers = new Headers({ 'cache-control': 'no-store' });
  if (result.status === 'ok' || result.status === 'not_modified') {
    headers.set('etag', result.etag);
  }
  if (result.status === 'unavailable') {
    headers.set('retry-after', String(result.retryAfterSeconds));
  }
  if (result.status === 'not_modified') return new Response(null, { status, headers });
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(result), { status, headers });
}

type ParsedBody = { ok: true; value: BundleRequest } | { ok: false };

async function readBundleRequest(request: Request): Promise<ParsedBody> {
  const text = await request.text();
  if (text.trim() === '') return { ok: true, value: {} };
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const parsed = BundleRequestSchema.safeParse(document);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

async function discovery(env: Env, config: StsConfig): Promise<Response> {
  return jsonResponse(
    {
      issuer: `${config.issuer}${MANAGER_AUTH_PATH}`,
      jwks_uri: `${config.issuer}${JWKS_PATH}`,
      response_types_supported: ['id_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['EdDSA'],
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat'],
    },
    200,
    'public, max-age=300'
  );
}

async function keySet(env: Env, config: StsConfig): Promise<Response> {
  const jwks = await withDORetry(
    () => getSignerStub(env, config),
    stub => stub.getJwks(),
    'sts.getJwks'
  );
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

  const verifier = new IdentityVerifier({
    policies: policyIndex.all(),
    environment: config.environment,
    issuer: config.issuer,
    fetch: (input, init) => fetch(input, init),
  });
  const outcome = await verifier.verify(token);
  if (outcome.status === 'denied') {
    return bundleResponse({ status: 'denied', reason: outcome.reason });
  }

  const body = await readBundleRequest(request);
  if (!body.ok) return jsonResponse({ error: 'invalid_request' }, 400, 'no-store');
  return bundleResponse(await serveBundle(env, config, outcome.workload, body.value));
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const config = readConfig(env);
  const { pathname } = new URL(request.url);

  if (request.method === 'GET' && pathname === DISCOVERY_PATH) {
    return await discovery(env, config);
  }
  if (request.method === 'GET' && pathname === JWKS_PATH) {
    return await keySet(env, config);
  }
  if (request.method === 'POST' && pathname === STS_BUNDLE_HTTP_PATH) {
    return await bundleRequest(request, env, config);
  }
  return new Response('not found', { status: 404 });
}
