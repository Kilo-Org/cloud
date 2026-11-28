import 'server-only';
import { waitUntil } from '@vercel/functions';
import { STS_ISSUERS, STS_USAGE_RECORD, type StsEnvironment } from '@kilocode/sts-contracts';
import { ENKRYPT_USAGE_WRITE_PATH, EXA_USAGE_WRITE_PATH } from '@kilocode/usage-contracts';
import {
  createVerifier,
  failureResponse,
  httpJwksSource,
  type Verifier,
  type VerifyFailure,
} from '@kilocode/verify';
import { STS_URL } from '@kilocode/web-shared/lib/config.server';
import { APP_URL, resolveAppUrl } from '@kilocode/web-shared/lib/constants';
import { callerLabel, observeInternalAuth } from '@kilocode/worker-utils/internal-auth-observation';
import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';

/**
 * `USAGE_RECORD_AUTH` selects what the three usage record routes accept (design 6.5: the
 * usage-ingest queue consumer's internal API secret moves to an STS service token):
 * - absent, empty or `legacy`: only the internal API secret through `authorizeInternalApiRequest`,
 *   exactly as before this switch existed, with no STS work;
 * - `dual`: the request names one credential family. An `Authorization` header selects STS: a
 *   `STS_USAGE_RECORD` token from the `usage-ingest` workload on a `x-usage-write-source: queue`
 *   request, and its refusal is final. A secret header selects the internal API secret, checked as
 *   under `legacy`, so the region handoff and the other secret callers keep their credential
 *   whatever the queue sends. Neither gets the legacy 401 plus the route's RFC 9728 challenge; both
 *   are refused.
 * - `sts`: only the `dual` STS check. A request carrying the internal API secret is refused with
 *   the 401 and the route's challenge before the secret is compared, the write source is read or
 *   the body is touched, and it never falls back to the secret: not on a refused token, an
 *   unreachable key set or a missing STS deployment (503). Every secret caller of these routes
 *   (both region handoffs, the auto-routing classifier and benchmark grader, a legacy queue
 *   consumer) must have moved to STS first.
 * Any other value refuses every request with 503. Rollback: `sts` to `dual` is safe at any time;
 * from `dual`, switch usage-ingest's `USAGE_WRITER_AUTH` back to `legacy` first, then this
 * receiver; the region handoff and the other existing secret callers stay accepted under `dual`.
 */
type UsageRecordAuthMode = 'legacy' | 'dual' | 'sts';

function usageRecordAuthMode(value: string | undefined): UsageRecordAuthMode | null {
  if (value === undefined || value === '' || value === 'legacy') return 'legacy';
  return value === 'dual' || value === 'sts' ? value : null;
}

const USAGE_RECORD_PATHS = [
  '/api/internal/usage/record',
  ENKRYPT_USAGE_WRITE_PATH,
  EXA_USAGE_WRITE_PATH,
] as const;
type UsageRecordPath = (typeof USAGE_RECORD_PATHS)[number];

/**
 * The observation label of a record route (design section 9.4, item 9): the fixed route family,
 * never the request's own path or a value from it.
 */
function usageRecordRoute(path: UsageRecordPath): string {
  if (path === ENKRYPT_USAGE_WRITE_PATH) return 'enkrypt_usage_record';
  if (path === EXA_USAGE_WRITE_PATH) return 'exa_usage_record';
  return 'usage_record';
}

/** STS grants `STS_USAGE_RECORD` only to this workload; the routes repeat the check. */
const USAGE_RECORD_WORKLOAD = 'usage-ingest';

/** A `web:usage.record` token authorizes only the queue consumer's writes. */
const QUEUE_SOURCE = 'queue';

/**
 * RFC 9728 section 3.1 inserts this between the origin and the path of a resource. Each record
 * route is its own resource, so its metadata never takes the origin's own document, which belongs
 * to the app's UTS resource.
 */
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

const LOOPBACK_HOSTNAMES: Record<string, true> = {
  localhost: true,
  '127.0.0.1': true,
  '[::1]': true,
};

const NO_STORE = { 'cache-control': 'no-store' };

type StsDeployment = { environment: StsEnvironment; issuer: string; origin: string };

/**
 * This deployment's STS environment by the internal API secret's own rule
 * (`stsEnvironmentOfDeployment`), its issuer, which `STS_URL` must equal, and the app's canonical
 * origin from `APP_URL`: the production or staging app origin, or an `http:` or `https:` loopback
 * origin in development. Never the request's Host. Null: an STS token gets 503, a request without
 * credentials the plain legacy 401, and the metadata is a 404.
 */
async function stsDeployment(): Promise<StsDeployment | null> {
  // Loaded on the first STS request only. Not a static import: that would load the transport's
  // secrets client and Vercel OIDC exchange on every legacy request; `sts-secret-reader.ts` defers
  // this module the same way.
  const { stsEnvironmentOfDeployment } =
    await import('@kilocode/web-shared/lib/sts-secret-transport');
  let environment: StsEnvironment;
  try {
    environment = stsEnvironmentOfDeployment(process.env);
  } catch {
    return null;
  }
  const issuer = STS_ISSUERS[environment];
  if (STS_URL !== issuer) return null;
  // A bad local `PORT` leaves `APP_URL` unparsable: no STS deployment rather than a thrown request.
  if (!URL.canParse(APP_URL)) return null;
  const app = new URL(APP_URL);
  const canonical =
    environment === 'development'
      ? (app.protocol === 'http:' || app.protocol === 'https:') &&
        LOOPBACK_HOSTNAMES[app.hostname] === true
      : app.origin ===
        resolveAppUrl(
          environment === 'production' ? { nodeEnv: 'production' } : { vercelTargetEnv: 'staging' }
        );
  return canonical ? { environment, issuer, origin: app.origin } : null;
}

function metadataUrl(origin: string, path: UsageRecordPath): string {
  return `${origin}${PROTECTED_RESOURCE_PATH}${path}`;
}

/** The route whose RFC 9728 document the shared verifier's own challenges name. */
const VERIFIER_PATH: UsageRecordPath = '/api/internal/usage/record';

/**
 * One verifier, so one STS key-set cache, for all three routes (design section 7), rebuilt only if
 * the deployment's environment or origin changes. Its challenges name `VERIFIER_PATH`'s document;
 * `routeFailure` names the refused route's instead.
 */
let verifier: { key: string; instance: Verifier<false> } | null = null;

function verifierFor(deployment: StsDeployment): Verifier<false> {
  const key = `${deployment.environment}|${deployment.origin}`;
  if (verifier?.key !== key) {
    verifier = {
      key,
      instance: createVerifier({
        audience: STS_USAGE_RECORD.audience,
        environment: deployment.environment,
        resourceMetadataUrl: metadataUrl(deployment.origin, VERIFIER_PATH),
        sts: { issuer: deployment.issuer, jwks: httpJwksSource(deployment.issuer) },
      }),
    };
  }
  return verifier.instance;
}

/**
 * The library's refusal with its challenge's `resource_metadata` naming `path`'s own RFC 9728
 * document. Status, body, reason, `Retry-After` and `no-store` stay as the library built them.
 */
function routeFailure(
  failure: VerifyFailure,
  origin: string,
  path: UsageRecordPath
): VerifyFailure {
  const challenge = failure.headers['www-authenticate'];
  if (path === VERIFIER_PATH || challenge === undefined) return failure;
  const shared = `resource_metadata="${metadataUrl(origin, VERIFIER_PATH)}"`;
  const routed = `resource_metadata="${metadataUrl(origin, path)}"`;
  return {
    ...failure,
    headers: { ...failure.headers, 'www-authenticate': challenge.replace(shared, () => routed) },
  };
}

/** Fixed fields only; never a credential or a configured value. */
function log(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event, ...fields }));
}

function insufficientScope(
  deployment: StsDeployment,
  path: UsageRecordPath,
  reason: 'workload' | 'source'
): Response {
  const { scope } = STS_USAGE_RECORD;
  log('usage_record_auth_refused', { path, status: 403, error: 'insufficient_scope', reason });
  return Response.json(
    { error: 'insufficient_scope', scope },
    {
      status: 403,
      headers: {
        ...NO_STORE,
        'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${metadataUrl(deployment.origin, path)}"`,
      },
    }
  );
}

async function authorizeServiceToken(
  request: Request,
  path: UsageRecordPath
): Promise<Response | null> {
  const deployment = await stsDeployment();
  if (deployment === null) return unconfigured(path);
  const result = await verifierFor(deployment).verify(
    request,
    { issuer: 'sts', scope: STS_USAGE_RECORD.scope },
    { waitUntil }
  );
  if (!result.ok) {
    log('usage_record_auth_refused', {
      path,
      status: result.status,
      error: result.error,
      reason: result.reason,
    });
    return failureResponse(routeFailure(result, deployment.origin, path));
  }
  if (result.caller.kind !== 'service' || result.caller.workload !== USAGE_RECORD_WORKLOAD) {
    return insufficientScope(deployment, path, 'workload');
  }
  if (request.headers.get('x-usage-write-source') !== QUEUE_SOURCE) {
    return insufficientScope(deployment, path, 'source');
  }
  observeInternalAuth('web', usageRecordRoute(path), 'sts', callerLabel(result.caller.workload));
  return null;
}

function unconfigured(path: UsageRecordPath): Response {
  // A configuration fault, not the verifier dependency outage that design section 7's
  // `temporarily_unavailable` with `Retry-After` describes.
  log('usage_record_auth_sts_unconfigured', { path });
  return Response.json({ error: 'Service unavailable' }, { status: 503, headers: NO_STORE });
}

function unauthorized(deployment: StsDeployment, path: UsageRecordPath): Response {
  return Response.json(
    { error: 'Unauthorized' },
    {
      status: 401,
      headers: {
        ...NO_STORE,
        'www-authenticate': `Bearer resource_metadata="${metadataUrl(deployment.origin, path)}"`,
      },
    }
  );
}

/**
 * The legacy 401 for a `dual` request with neither credential family, plus the route's RFC 9728
 * challenge (design section 7). Without an STS deployment there is no metadata to name, so it stays
 * the plain legacy refusal. Verifies nothing and fetches no key set.
 */
async function missingCredential(
  request: Request,
  path: UsageRecordPath
): Promise<Response | null> {
  const deployment = await stsDeployment();
  if (deployment === null) return authorizeInternalApiRequest(request, usageRecordRoute(path));
  return unauthorized(deployment, path);
}

/**
 * The `sts` refusal of a request without a bearer, whether it carries the internal API secret or
 * nothing: the 401 and the route's challenge. Never compares or reads the secret; 503 without an
 * STS deployment, since then no credential can be accepted.
 */
async function refuseWithoutToken(path: UsageRecordPath, secret: boolean): Promise<Response> {
  const deployment = await stsDeployment();
  if (deployment === null) return unconfigured(path);
  if (secret) {
    log('usage_record_auth_refused', { path, status: 401, reason: 'legacy_credential' });
  }
  return unauthorized(deployment, path);
}

/**
 * Authenticates a usage record request before its body is read or any writer work starts. Resolves
 * null when it admits the request; otherwise the response to send.
 */
export async function authorizeUsageRecordRequest(
  request: Request,
  path: UsageRecordPath
): Promise<Response | null> {
  const mode = usageRecordAuthMode(process.env.USAGE_RECORD_AUTH);
  if (mode === 'legacy') return authorizeInternalApiRequest(request, usageRecordRoute(path));
  if (mode === null) {
    log('usage_record_auth_misconfigured', { path });
    return Response.json({ error: 'Service unavailable' }, { status: 503, headers: NO_STORE });
  }
  const bearer = request.headers.has('authorization');
  const secret =
    request.headers.has('x-internal-api-key') || request.headers.has('x-internal-secret');
  if (bearer && secret) {
    log('usage_record_auth_refused', {
      path,
      status: 400,
      error: 'invalid_request',
      reason: 'mixed_credentials',
    });
    return Response.json({ error: 'invalid_request' }, { status: 400, headers: NO_STORE });
  }
  if (bearer) return authorizeServiceToken(request, path);
  if (mode === 'sts') return refuseWithoutToken(path, secret);
  return secret
    ? authorizeInternalApiRequest(request, usageRecordRoute(path))
    : missingCredential(request, path);
}

/**
 * The RFC 9728 metadata the STS challenges of the record route `/api/internal/<product>/record`
 * name. Served only while `USAGE_RECORD_AUTH` is `dual` or `sts` and the deployment has an STS
 * environment, issuer and canonical origin; otherwise, and for any other product, a plain 404.
 */
export async function usageRecordResourceMetadata(product: string): Promise<Response> {
  const notFound = new Response(null, { status: 404 });
  const mode = usageRecordAuthMode(process.env.USAGE_RECORD_AUTH);
  if (mode !== 'dual' && mode !== 'sts') return notFound;
  const path = USAGE_RECORD_PATHS.find(
    candidate => candidate === `/api/internal/${product}/record`
  );
  if (path === undefined) return notFound;
  const deployment = await stsDeployment();
  if (deployment === null) return notFound;
  return Response.json(
    {
      resource: `${deployment.origin}${path}`,
      authorization_servers: [deployment.issuer],
      scopes_supported: [STS_USAGE_RECORD.scope],
      bearer_methods_supported: ['header'],
    },
    { headers: NO_STORE }
  );
}
