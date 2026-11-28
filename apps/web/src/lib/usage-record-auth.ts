import 'server-only';
import { STS_USAGE_RECORD } from '@kilocode/sts-contracts';
import { ENKRYPT_USAGE_WRITE_PATH, EXA_USAGE_WRITE_PATH } from '@kilocode/usage-contracts';
import { observeInternalAuth } from '@kilocode/worker-utils/internal-auth-observation';
import {
  WEB_USAGE_BENCHMARK_GRADER_RECORD,
  WEB_USAGE_CLASSIFIER_RECORD,
  WEB_USAGE_REGION_HANDOFF_RECORD,
  authorizeInternalApiRequest,
  insufficientScope,
  verifyServiceToken,
  webStsDeployment,
  type ServiceGrant,
  type WebStsDeployment,
} from '@/lib/internal-api-auth';

/**
 * `USAGE_RECORD_AUTH` selects what the three usage record routes accept (design 6.5: each writer's
 * internal API secret moves to an STS service token of its own scope):
 * - absent, empty or `legacy`: only the internal API secret through `authorizeInternalApiRequest`,
 *   exactly as before this switch existed, with no STS work;
 * - `dual`: the request names one credential family. An `Authorization` header selects STS: a
 *   token of one of the route's `RECORD_GRANTS`, from that grant's workload, on a request whose
 *   `x-usage-write-source` is exactly that grant's source, and its refusal is final. A secret
 *   header selects the internal API secret, checked as under `legacy`, so every secret caller keeps
 *   its credential whatever the others send. Neither gets the legacy 401 plus the route's RFC 9728
 *   challenge; both are refused.
 * - `sts`: only the `dual` STS check. A request carrying the internal API secret is refused with
 *   the 401 and the route's challenge before the secret is compared, the write source is read or
 *   the body is touched, and it never falls back to the secret: not on a refused token, an
 *   unreachable key set or a missing STS deployment (503). Every secret caller of these routes
 *   (the queue consumer, both region handoffs, the auto-routing classifier and the benchmark
 *   grader) must have moved to STS first.
 * Any other value refuses every request with 503. Rollback: `sts` to `dual` is safe at any time;
 * from `dual`, switch each sender back to `legacy` first, then this receiver.
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

/**
 * One writer's grant: its scope and workload, and the exact `x-usage-write-source` its writes
 * carry (null: the header is absent). A scope authorizes only that writer's own writes: the queue
 * scope never admits a region handoff, and no other scope can claim queue admission.
 */
type RecordGrant = ServiceGrant & { source: string | null };

const QUEUE: RecordGrant = {
  scope: STS_USAGE_RECORD.scope,
  workload: 'usage-ingest',
  caller: 'usage-ingest',
  source: 'queue',
};

/**
 * The writers of each route, by their senders (`services/usage-ingest/src/consume-usage.ts`,
 * `packages/web-shared/src/lib/ai-gateway/usage-record-client.ts` and
 * `enkrypt-guardrail/usage-primary-region.ts`, `services/auto-routing/src/classifier-usage.ts`,
 * `services/auto-routing-benchmark/src/grader-usage.ts`) and the workloads STS policy grants
 * their scopes to. The queue grant comes first: it carries nearly all of the traffic.
 */
const RECORD_GRANTS: Record<UsageRecordPath, readonly [RecordGrant, ...RecordGrant[]]> = {
  '/api/internal/usage/record': [
    QUEUE,
    {
      scope: WEB_USAGE_REGION_HANDOFF_RECORD,
      workload: 'ai-gateway',
      caller: 'ai-gateway',
      source: 'region_handoff',
    },
    {
      scope: WEB_USAGE_CLASSIFIER_RECORD,
      workload: 'auto-routing',
      caller: 'auto-routing',
      source: null,
    },
    {
      scope: WEB_USAGE_BENCHMARK_GRADER_RECORD,
      workload: 'auto-routing-benchmark',
      caller: 'auto-routing-benchmark',
      source: null,
    },
  ],
  [ENKRYPT_USAGE_WRITE_PATH]: [
    QUEUE,
    {
      scope: WEB_USAGE_REGION_HANDOFF_RECORD,
      workload: 'ai-gateway',
      caller: 'ai-gateway',
      source: null,
    },
  ],
  [EXA_USAGE_WRITE_PATH]: [QUEUE],
};

/**
 * RFC 9728 section 3.1 inserts this between the origin and the path of a resource. Each record
 * route is its own resource, so its challenges and metadata name its own document.
 */
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

const NO_STORE = { 'cache-control': 'no-store' };

function metadataUrl(origin: string, path: UsageRecordPath): string {
  return `${origin}${PROTECTED_RESOURCE_PATH}${path}`;
}

/** Fixed fields only; never a credential or a configured value. */
function log(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event, ...fields }));
}

/**
 * The route's grants, those whose source the request carries first. The queue writer and the
 * region handoff each cost one verification; the classifier and the grader share the absent
 * source, so the classifier costs one and the grader two. The order decides only which scope a
 * refusal names: the source is checked after the token, against the grant the token matched.
 */
function grantsFor(request: Request, path: UsageRecordPath): readonly RecordGrant[] {
  const source = request.headers.get('x-usage-write-source');
  const grants = RECORD_GRANTS[path];
  return [
    ...grants.filter(grant => grant.source === source),
    ...grants.filter(grant => grant.source !== source),
  ];
}

async function authorizeServiceToken(
  request: Request,
  path: UsageRecordPath
): Promise<Response | null> {
  const deployment = await webStsDeployment();
  if (deployment === null) return unconfigured(path);
  const grants = grantsFor(request, path);
  const checked = await verifyServiceToken(
    request,
    deployment,
    grants,
    metadataUrl(deployment.origin, path)
  );
  if (!checked.ok) {
    log('usage_record_auth_refused', {
      path,
      status: checked.status,
      error: checked.error,
      reason: checked.reason,
    });
    return checked.response;
  }
  const { grant } = checked;
  if (request.headers.get('x-usage-write-source') !== grant.source) {
    log('usage_record_auth_refused', {
      path,
      status: 403,
      error: 'insufficient_scope',
      reason: 'source',
    });
    return insufficientScope(grant.scope, metadataUrl(deployment.origin, path));
  }
  observeInternalAuth('web', usageRecordRoute(path), 'sts', grant.caller);
  return null;
}

function unconfigured(path: UsageRecordPath): Response {
  // A configuration fault, not the verifier dependency outage that design section 7's
  // `temporarily_unavailable` with `Retry-After` describes.
  log('usage_record_auth_sts_unconfigured', { path });
  return Response.json({ error: 'Service unavailable' }, { status: 503, headers: NO_STORE });
}

function unauthorized(deployment: WebStsDeployment, path: UsageRecordPath): Response {
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
  const deployment = await webStsDeployment();
  if (deployment === null) return authorizeInternalApiRequest(request, usageRecordRoute(path));
  return unauthorized(deployment, path);
}

/**
 * The `sts` refusal of a request without a bearer, whether it carries the internal API secret or
 * nothing: the 401 and the route's challenge. Never compares or reads the secret; 503 without an
 * STS deployment, since then no credential can be accepted.
 */
async function refuseWithoutToken(path: UsageRecordPath, secret: boolean): Promise<Response> {
  const deployment = await webStsDeployment();
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
  const deployment = await webStsDeployment();
  if (deployment === null) return notFound;
  return Response.json(
    {
      resource: `${deployment.origin}${path}`,
      authorization_servers: [deployment.issuer],
      scopes_supported: RECORD_GRANTS[path].map(grant => grant.scope),
      bearer_methods_supported: ['header'],
    },
    { headers: NO_STORE }
  );
}
