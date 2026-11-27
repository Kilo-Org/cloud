import { timingSafeEqual } from '@kilocode/encryption';
import { STS_USAGE_PUBLISH } from '@kilocode/sts-contracts';
import { failureResponse } from '@kilocode/verify';
import { logSafely } from './diagnostics';
import {
  publishVerifierFor,
  publishVerifyConfig,
  USAGE_INGEST_RESOURCE_ORIGINS,
  type StsEnv,
} from './sts';

/**
 * `USAGE_INGEST_PUBLISH_AUTH`, the per-receiver switch and its rollback:
 * - absent or `legacy`: only the publish secret, exactly as before this switch existed;
 * - `dual`: the publish secret, or an STS token of `STS_USAGE_PUBLISH` (all three publish paths);
 * - `sts`: only an STS token.
 * Any other value refuses every publish with 503.
 */
export type PublishAuthMode = 'legacy' | 'dual' | 'sts';

export type PublishAuthEnv = StsEnv & {
  USAGE_INGEST_PUBLISH_SECRET?: string;
  USAGE_INGEST_PUBLISH_AUTH?: string;
};

/**
 * Fields the accepted request's `usage_ingest_enqueue_start` line carries. Empty under `legacy`, so
 * that line keeps its shape; otherwise the credential that authenticated it, so the count of
 * requests the shared secret still authenticates can be read per caller, path and minute.
 */
export type PublishAuthFields = { auth?: 'legacy' | 'sts'; auth_caller?: string };

export function publishAuthMode(value: string | undefined): PublishAuthMode | null {
  if (value === undefined || value === 'legacy') return 'legacy';
  return value === 'dual' || value === 'sts' ? value : null;
}

export type PublishPath = '/usage' | '/enkrypt-usage' | '/exa-usage';

/**
 * The one STS workload each publish path accepts, from the publishers in this repository: the AI
 * gateway's LLM proxy publishes LLM and Enkrypt usage, and only the web app's `/api/exa` route
 * publishes Exa usage. A valid token of any other workload is refused before the body is read.
 */
export const PUBLISH_WORKLOADS: Readonly<Record<PublishPath, string>> = {
  '/usage': 'ai-gateway',
  '/enkrypt-usage': 'ai-gateway',
  '/exa-usage': 'web',
};

/**
 * A compact JWS bearer, the only form an STS token takes; under `dual` only such a bearer reaches
 * the verifier.
 */
const JWS_BEARER = /^Bearer +[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+ *$/i;

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/**
 * The RFC 9728 metadata the publish routes' challenges point at, served at
 * `RESOURCE_METADATA_PATH` only while `USAGE_INGEST_PUBLISH_AUTH` is `dual` or `sts` and the STS
 * issuer and environment are valid. Built from the same fixed origin, issuer and single publish
 * scope as the verifier, never from the request. `null`: the path stays an ordinary 404.
 */
export function publishResourceMetadata(env: PublishAuthEnv): Response | null {
  const mode = publishAuthMode(env.USAGE_INGEST_PUBLISH_AUTH);
  if (mode !== 'dual' && mode !== 'sts') return null;
  const configured = publishVerifyConfig(env);
  if (configured === null) return null;
  return Response.json({
    resource: USAGE_INGEST_RESOURCE_ORIGINS[configured.environment],
    authorization_servers: [configured.stsUrl],
    scopes_supported: [STS_USAGE_PUBLISH.scope],
    bearer_methods_supported: ['header'],
    resource_name: 'Kilo usage ingest',
  });
}

/**
 * Authenticates a publish request before its body is read. Under `dual`, a request that is not an
 * exact secret match and carries a compact JWS goes to STS verification, whose refusal is final:
 * it never falls back to the secret. Every other request keeps the secret's answers: 503 without a
 * configured secret, 401 otherwise. An STS caller must be the path's `PUBLISH_WORKLOADS` entry.
 */
export async function authorizePublish(
  request: Request,
  env: PublishAuthEnv,
  path: PublishPath,
  ctx: ExecutionContext | undefined
): Promise<PublishAuthFields | Response> {
  const mode = publishAuthMode(env.USAGE_INGEST_PUBLISH_AUTH);
  if (mode === null) {
    logSafely('warn', () => ({ event: 'usage_ingest_publish_auth_misconfigured', path }));
    return errorResponse('Service unavailable', 503);
  }
  const secret = env.USAGE_INGEST_PUBLISH_SECRET;
  const authorization = request.headers.get('Authorization');
  if (mode !== 'sts') {
    const legacy = Boolean(
      secret && authorization && timingSafeEqual(authorization, `Bearer ${secret}`)
    );
    if (legacy) return mode === 'legacy' ? {} : { auth: 'legacy' };
    if (mode === 'legacy' || authorization === null || !JWS_BEARER.test(authorization)) {
      return secret
        ? errorResponse('Unauthorized', 401)
        : errorResponse('Service unavailable', 503);
    }
  }

  const configured = publishVerifyConfig(env);
  if (configured === null) {
    logSafely('warn', () => ({ event: 'usage_ingest_publish_auth_sts_unconfigured', path }));
    return errorResponse('Service unavailable', 503);
  }
  const waitUntil = (promise: Promise<unknown>) => {
    if (ctx === undefined) void promise;
    else ctx.waitUntil(promise);
  };
  const result = await publishVerifierFor(configured).verify(
    request,
    { issuer: 'sts', scope: STS_USAGE_PUBLISH.scope },
    { waitUntil }
  );
  if (!result.ok) {
    logSafely('warn', () => ({
      event: 'usage_ingest_publish_auth_refused',
      path,
      status: result.status,
      error: result.error,
      reason: result.reason,
    }));
    return failureResponse(result);
  }
  const workload = result.caller.kind === 'service' ? result.caller.workload : null;
  if (workload !== PUBLISH_WORKLOADS[path]) {
    logSafely('warn', () => ({
      event: 'usage_ingest_publish_auth_refused',
      path,
      status: 403,
      error: 'insufficient_scope',
      reason: 'workload',
      auth_caller: workload ?? result.caller.kind,
    }));
    return Response.json(
      { error: 'insufficient_scope' },
      { status: 403, headers: { 'cache-control': 'no-store' } }
    );
  }
  return { auth: 'sts', auth_caller: workload };
}
