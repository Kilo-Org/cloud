import { timingSafeEqual } from '@kilocode/encryption';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import {
  STS_ISSUERS,
  STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH,
  type StsEnvironment,
} from '@kilocode/sts-contracts';
import { createVerifier, httpJwksSource, type Verifier, type VerifyFailure } from '@kilocode/verify';
import { STS_URL } from '@kilocode/web-shared/lib/config.server';
import { APP_URL, resolveAppUrl } from '@kilocode/web-shared/lib/constants';
import {
  INTERNAL_CALLER_HEADER,
  callerLabel,
  observeInternalAuth,
} from '@kilocode/worker-utils/internal-auth-observation';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';

// Both headers carry the same shared secret; the two spellings come from
// different internal callers and must be accepted interchangeably.
//
// `route` is the receiving route family, a literal at each call site, and only labels the
// observation line (design section 9.4, item 9): one accepted request reports that a shared secret
// authenticated here, so the kill-date gate can count what still arrives that way.
export async function authorizeInternalApiRequest(
  request: Request,
  route: string
): Promise<NextResponse | null> {
  const secret =
    request.headers.get('x-internal-api-key') ?? request.headers.get('x-internal-secret');
  // A request without a credential is refused without reading the expected value.
  const expected = secret ? await readInternalApiSecret() : '';

  if (!expected || !secret || !timingSafeEqual(secret, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  observeInternalAuth(
    'web',
    route,
    'legacy_shared_secret',
    callerLabel(request.headers.get(INTERNAL_CALLER_HEADER))
  );
  return null;
}

// ---------------------------------------------------------------------------------------------
// STS service tokens on the web app's internal routes (design 6.5: the shared internal API secret
// and the derived callback tokens move to STS service tokens, one scope per sender boundary).
// ---------------------------------------------------------------------------------------------

const LOOPBACK_HOSTNAMES: Record<string, true> = {
  localhost: true,
  '127.0.0.1': true,
  '[::1]': true,
};

const NO_STORE = { 'cache-control': 'no-store' };

/** The RFC 9728 path of the app origin's own document; challenges name it (as `sts-canary`). */
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

export type WebStsDeployment = { environment: StsEnvironment; issuer: string; origin: string };

/**
 * This deployment's STS environment by the internal API secret's own rule
 * (`stsEnvironmentOfDeployment`), its issuer, which `STS_URL` must equal, and the app's canonical
 * origin from `APP_URL`: the production or staging app origin, or an `http:` or `https:` loopback
 * origin in development. Never the request's Host. Null: no STS token can be accepted (503).
 */
export async function webStsDeployment(): Promise<WebStsDeployment | null> {
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

function originMetadataUrl(origin: string): string {
  return `${origin}${PROTECTED_RESOURCE_PATH}`;
}

/**
 * One verifier, so one STS key-set cache, for every internal route of audience `web` (design
 * section 7), rebuilt only if the deployment's environment or origin changes.
 */
let verifier: { key: string; instance: Verifier<false> } | null = null;

function verifierFor(deployment: WebStsDeployment): Verifier<false> {
  const key = `${deployment.environment}|${deployment.origin}`;
  if (verifier?.key !== key) {
    verifier = {
      key,
      instance: createVerifier({
        audience: 'web',
        environment: deployment.environment,
        resourceMetadataUrl: originMetadataUrl(deployment.origin),
        sts: { issuer: deployment.issuer, jwks: httpJwksSource(deployment.issuer) },
      }),
    };
  }
  return verifier.instance;
}

/** Fixed fields only; never a credential, a claim value or a configured value. */
function log(event: string, fields: Record<string, string | number>): void {
  console.warn(JSON.stringify({ event, ...fields }));
}

/**
 * One scope a route accepts and the one workload STS policy grants it to. `caller` is the fixed
 * observation label of that workload (an `INTERNAL_CALLERS` name), never a value from the request.
 */
export type ServiceGrant = { scope: string; workload: string; caller: string };

/** The refusal of a route's own check, with the route's RFC 9728 challenge. */
export function insufficientScope(scope: string, resourceMetadataUrl: string): Response {
  return Response.json(
    { error: 'insufficient_scope', scope },
    {
      status: 403,
      headers: {
        ...NO_STORE,
        'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${resourceMetadataUrl}"`,
      },
    }
  );
}

function failureResponseFor(failure: VerifyFailure, origin: string, metadata: string): Response {
  const shared = `resource_metadata="${originMetadataUrl(origin)}"`;
  const routed = `resource_metadata="${metadata}"`;
  const headers: Record<string, string> = { ...failure.headers };
  const challenge = headers['www-authenticate'];
  if (challenge !== undefined && shared !== routed) {
    headers['www-authenticate'] = challenge.replace(shared, () => routed);
  }
  return failure.body === null
    ? new Response(null, { status: failure.status, headers })
    : Response.json(failure.body, { status: failure.status, headers });
}

export type ServiceTokenCheck<G extends ServiceGrant = ServiceGrant> =
  | { ok: true; grant: G }
  | { ok: false; response: Response; status: number; error: string; reason: string };

/**
 * Verifies the request's STS bearer for one of `grants`, tried in order: audience `web`, the
 * deployment's issuer and `env`, a registered scope equal to the grant's, then the grant's
 * workload. Only a scope that names another grant moves to the next one; every other refusal is
 * final, and nothing here ever falls back to another credential. A warm check is a memory read
 * plus one Ed25519 verification per grant tried. `resourceMetadataUrl` is the document the
 * refusal's challenge names.
 */
export async function verifyServiceToken<G extends ServiceGrant>(
  request: Request,
  deployment: WebStsDeployment,
  grants: readonly G[],
  resourceMetadataUrl: string
): Promise<ServiceTokenCheck<G>> {
  const instance = verifierFor(deployment);
  // The refusal reported when every grant names another scope is the first grant's.
  let failure: VerifyFailure | null = null;
  for (const grant of grants) {
    const result = await instance.verify(
      request,
      { issuer: 'sts', scope: grant.scope },
      { waitUntil }
    );
    if (result.ok) {
      if (result.caller.kind === 'service' && result.caller.workload === grant.workload) {
        return { ok: true, grant };
      }
      return {
        ok: false,
        response: insufficientScope(grant.scope, resourceMetadataUrl),
        status: 403,
        error: 'insufficient_scope',
        reason: 'workload',
      };
    }
    if (result.reason !== 'scope_mismatch') {
      failure = result;
      break;
    }
    failure ??= result;
  }
  if (failure === null) throw new Error('verifyServiceToken needs at least one grant');
  return {
    ok: false,
    response: failureResponseFor(failure, deployment.origin, resourceMetadataUrl),
    status: failure.status,
    error: failure.error ?? 'missing_credential',
    reason: failure.reason,
  };
}

// --- Scopes pending registration in `@kilocode/sts-contracts`. ------------------------------
// Each is registered and granted on `igor/sts-c1-registry` (p2). Until that lands, the verifier
// refuses them as `scope_unknown` (403) and STS mints none of them. Once registered, import each
// from `@kilocode/sts-contracts` and delete it here.
const WEB_AUTO_ROUTING_POOL_PINS_WRITE = 'web:auto-routing.pool-pins.write';
const WEB_AUTO_ROUTING_PRODUCTION_PROFILE_READ = 'web:auto-routing.production-profile.read';
const WEB_USAGE_RECEIPTS_READ = 'web:usage.receipts.read';
const WEB_CLAUDE_BILLING_PAYER_STATE_READ = 'web:claude-billing.payer-state.read';
const WEB_BYOC_CREDENTIALS_READ = 'web:byoc-credentials.read';
const WEB_BYOC_CREDENTIALS_WRITE = 'web:byoc-credentials.write';
const WEB_HOSTED_WORKSPACE_PULL_REQUESTS_REFRESH = 'web:hosted-workspace-pull-requests.refresh';
const WEB_GLANCEABLE_SNAPSHOT_READ = 'web:glanceable-snapshot.read';
const WEB_COMPUTE_BALANCE_ALERT_SEND = 'web:compute-balance-alert.send';
const WEB_SCIM_SYNC = 'web:scim.sync';
const WEB_USER_DATA_EXPORTS_READY = 'web:user-data-exports.ready';
const WEB_SECURITY_NOTIFICATIONS_LIFECYCLE = 'web:security-notifications.lifecycle';
export const WEB_USAGE_CLASSIFIER_RECORD = 'web:usage.classifier.record';
export const WEB_USAGE_BENCHMARK_GRADER_RECORD = 'web:usage.benchmark-grader.record';
export const WEB_USAGE_REGION_HANDOFF_RECORD = 'web:usage.region-handoff.record';
// --- End of scopes pending registration. -----------------------------------------------------

type ReceiverMode = 'legacy' | 'dual' | 'sts';

/**
 * One receiving edge: its switch, how its legacy credential travels and the grants STS policy
 * gives its senders.
 * - `switch`: the Vercel variable. Absent, empty or `legacy` keeps only the route's legacy check,
 *   exactly as before, with no STS work; `dual` also accepts an STS token; `sts` accepts only
 *   the token. Any other value refuses every request with 503.
 * - `legacyHeaders`: every header the route's legacy check reads.
 * - `bearerSecret`: the legacy secret travels as `Authorization: Bearer <secret>`, the header an
 *   STS token uses too. Under `dual` the route's legacy check runs first on every bearer and an
 *   exact match is legacy; under `sts` every bearer is an STS token and the secret is never read.
 *
 * The code review status callback (`/api/internal/code-review-status/{reviewId}`) is not an edge:
 * its derived token binds the review and attempt, and a scope-only token would not. It moves with
 * the per-resource callback capability (M190).
 */
type ReceiverEdge = {
  switch: string;
  legacyHeaders: readonly string[];
  bearerSecret?: true;
  grants: readonly [ServiceGrant, ...ServiceGrant[]];
};

const SECRET_HEADERS = ['x-internal-api-key', 'x-internal-secret'] as const;

/**
 * Every header that carries a legacy internal credential on some web route. An STS bearer beside
 * any of them is two credential families, refused with 400 whatever the route reads.
 */
const LEGACY_CREDENTIAL_HEADERS = [
  ...SECRET_HEADERS,
  'x-callback-token',
  'x-bot-callback-token',
] as const;

const BENCHMARK = { workload: 'auto-routing-benchmark', caller: 'auto-routing-benchmark' } as const;
const CLOUD_AGENT_NEXT = { workload: 'cloud-agent-next', caller: 'cloud-agent-next' } as const;

const RECEIVER_EDGES = {
  auto_routing_pool_pins: {
    switch: 'AUTO_ROUTING_POOL_PINS_RECEIVER_AUTH',
    legacyHeaders: SECRET_HEADERS,
    grants: [{ scope: WEB_AUTO_ROUTING_POOL_PINS_WRITE, ...BENCHMARK }],
  },
  auto_routing_production_profile: {
    switch: 'AUTO_ROUTING_PRODUCTION_PROFILE_RECEIVER_AUTH',
    legacyHeaders: ['authorization'],
    bearerSecret: true,
    grants: [{ scope: WEB_AUTO_ROUTING_PRODUCTION_PROFILE_READ, ...BENCHMARK }],
  },
  usage_receipts: {
    switch: 'USAGE_RECEIPTS_RECEIVER_AUTH',
    legacyHeaders: SECRET_HEADERS,
    grants: [{ scope: WEB_USAGE_RECEIPTS_READ, ...BENCHMARK }],
  },
  claude_billing_payer_state: {
    switch: 'CLAUDE_BILLING_PAYER_STATE_RECEIVER_AUTH',
    legacyHeaders: SECRET_HEADERS,
    grants: [
      { scope: WEB_CLAUDE_BILLING_PAYER_STATE_READ, workload: 'ai-gateway', caller: 'ai-gateway' },
    ],
  },
  byoc_credentials_read: {
    switch: 'BYOC_CREDENTIALS_RECEIVER_AUTH',
    legacyHeaders: ['x-internal-api-key'],
    grants: [{ scope: WEB_BYOC_CREDENTIALS_READ, ...CLOUD_AGENT_NEXT }],
  },
  byoc_credentials_write: {
    switch: 'BYOC_CREDENTIALS_RECEIVER_AUTH',
    legacyHeaders: ['x-internal-api-key'],
    grants: [{ scope: WEB_BYOC_CREDENTIALS_WRITE, ...CLOUD_AGENT_NEXT }],
  },
  hosted_workspace_refresh: {
    switch: 'HOSTED_WORKSPACE_REFRESH_RECEIVER_AUTH',
    legacyHeaders: SECRET_HEADERS,
    grants: [{ scope: WEB_HOSTED_WORKSPACE_PULL_REQUESTS_REFRESH, ...CLOUD_AGENT_NEXT }],
  },
  glanceable_snapshot: {
    switch: 'GLANCEABLE_SNAPSHOT_RECEIVER_AUTH',
    legacyHeaders: ['x-internal-secret'],
    grants: [
      { scope: WEB_GLANCEABLE_SNAPSHOT_READ, workload: 'notifications', caller: 'notifications' },
    ],
  },
  compute_balance_alert: {
    switch: 'COMPUTE_BALANCE_ALERT_RECEIVER_AUTH',
    legacyHeaders: SECRET_HEADERS,
    grants: [
      {
        scope: WEB_COMPUTE_BALANCE_ALERT_SEND,
        workload: 'container-usage-meter',
        caller: 'container-usage-meter',
      },
    ],
  },
  scim_sync: {
    switch: 'SCIM_SYNC_RECEIVER_AUTH',
    legacyHeaders: SECRET_HEADERS,
    grants: [{ scope: WEB_SCIM_SYNC, workload: 'cloudflare-scim-sync', caller: 'scim-sync' }],
  },
  user_data_exports_ready: {
    switch: 'USER_DATA_EXPORT_READY_RECEIVER_AUTH',
    legacyHeaders: SECRET_HEADERS,
    grants: [
      {
        scope: WEB_USER_DATA_EXPORTS_READY,
        workload: 'user-data-export',
        caller: 'user-data-export',
      },
    ],
  },
  security_notifications: {
    switch: 'SECURITY_NOTIFICATIONS_RECEIVER_AUTH',
    legacyHeaders: SECRET_HEADERS,
    grants: [
      {
        scope: STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH.scope,
        workload: 'cloudflare-security-sync',
        caller: 'security-sync',
      },
      {
        scope: WEB_SECURITY_NOTIFICATIONS_LIFECYCLE,
        workload: 'security-auto-analysis',
        caller: 'security-auto-analysis',
      },
    ],
  },
} as const satisfies Record<string, ReceiverEdge>;

export type InternalServiceEdge = keyof typeof RECEIVER_EDGES;

/** The two scopes of the security notifications route; the route binds each to its body. */
export const SECURITY_NOTIFICATIONS_SCOPES = {
  dispatch: STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH.scope,
  lifecycle: WEB_SECURITY_NOTIFICATIONS_LIFECYCLE,
} as const;

/** How an admitted request authenticated: the route's legacy check, or an STS token's scope. */
export type InternalServiceCaller = { credential: 'legacy' } | { credential: 'sts'; scope: string };

function receiverMode(edge: ReceiverEdge): ReceiverMode | null {
  const value = process.env[edge.switch];
  if (value === undefined || value === '' || value === 'legacy') return 'legacy';
  return value === 'dual' || value === 'sts' ? value : null;
}

function toNextResponse(response: Response): NextResponse {
  return new NextResponse(response.body, { status: response.status, headers: response.headers });
}

function serviceUnavailable(): NextResponse {
  return NextResponse.json({ error: 'Service unavailable' }, { status: 503, headers: NO_STORE });
}

async function legacyResult(
  check: () => Promise<Response | null>
): Promise<NextResponse | InternalServiceCaller> {
  const refusal = await check();
  if (refusal === null) return { credential: 'legacy' };
  return refusal instanceof NextResponse ? refusal : toNextResponse(refusal);
}

/**
 * Authenticates one request to an internal route of `edge` before its body is read or any other
 * work starts. `route` is the fixed observation label of the call site. `legacy` is the route's
 * own legacy check, unchanged: the only code that ever reads or compares the legacy credential.
 *
 * Under `dual` the request names one credential family. A bearer is verified as an STS token for
 * the edge's grants and its refusal is final; a legacy credential header gets the legacy check; a
 * request without either gets the legacy check's own 401. Both families on one request get 400.
 * On a `bearerSecret` edge the legacy check runs first on a bearer: an exact match is legacy, any
 * other bearer goes to STS. Under `sts` a request without a bearer gets 401 with the challenge
 * before any legacy credential is read, the legacy check never runs, and a deployment without STS
 * (`webStsDeployment` null) refuses everything with 503. Secondary authorization (ownership,
 * membership, body binding) stays the route's own, after this.
 */
export async function authorizeInternalServiceRequest(
  request: Request,
  edge: InternalServiceEdge,
  route: string,
  legacy: () => Promise<Response | null>
): Promise<NextResponse | InternalServiceCaller> {
  const config: ReceiverEdge = RECEIVER_EDGES[edge];
  const mode = receiverMode(config);
  if (mode === 'legacy') return legacyResult(legacy);
  if (mode === null) {
    log('internal_service_auth_misconfigured', { route });
    return serviceUnavailable();
  }

  const bearer = request.headers.has('authorization');
  const legacyCredential = config.legacyHeaders.some(header => request.headers.has(header));

  // Two credential families on one request: a bearer beside any legacy internal credential header.
  // (On the edge whose legacy secret is itself the bearer, those headers are never its credential.)
  if (bearer && LEGACY_CREDENTIAL_HEADERS.some(header => request.headers.has(header))) {
    log('internal_service_auth_refused', {
      route,
      status: 400,
      error: 'invalid_request',
      reason: 'mixed_credentials',
    });
    return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers: NO_STORE });
  }

  if (mode === 'dual' && !bearer) return legacyResult(legacy);
  if (mode === 'dual' && config.bearerSecret) {
    // The legacy secret and an STS token share `Authorization` here, so under `dual` the exact
    // legacy match decides the family, never the bearer's shape: the route's own check runs first
    // and admits exactly what it admitted before. Any other bearer must be a valid STS token, and
    // that refusal is final. This reads the legacy secret for every bearer, so under `dual` the
    // STS path of this edge also depends on that read; under `sts` it is never read.
    const refusal = await legacy();
    if (refusal === null) return { credential: 'legacy' };
  }
  if (mode === 'sts' && !bearer) {
    const deployment = await webStsDeployment();
    if (deployment === null) {
      log('internal_service_auth_sts_unconfigured', { route });
      return serviceUnavailable();
    }
    if (legacyCredential) {
      log('internal_service_auth_refused', { route, status: 401, reason: 'legacy_credential' });
    }
    return NextResponse.json(
      { error: 'Unauthorized' },
      {
        status: 401,
        headers: {
          ...NO_STORE,
          'www-authenticate': `Bearer resource_metadata="${originMetadataUrl(deployment.origin)}"`,
        },
      }
    );
  }

  const deployment = await webStsDeployment();
  if (deployment === null) {
    // A configuration fault, not the verifier dependency outage that design section 7's
    // `temporarily_unavailable` with `Retry-After` describes.
    log('internal_service_auth_sts_unconfigured', { route });
    return serviceUnavailable();
  }
  const checked = await verifyServiceToken(
    request,
    deployment,
    config.grants,
    originMetadataUrl(deployment.origin)
  );
  if (!checked.ok) {
    log('internal_service_auth_refused', {
      route,
      status: checked.status,
      error: checked.error,
      reason: checked.reason,
    });
    return toNextResponse(checked.response);
  }
  observeInternalAuth('web', route, 'sts', checked.grant.caller);
  return { credential: 'sts', scope: checked.grant.scope };
}

/**
 * `authorizeInternalServiceRequest` for a route whose legacy check is `authorizeInternalApiRequest`
 * (the internal API secret in `x-internal-api-key` or `x-internal-secret`), labelled `route`.
 */
export function authorizeInternalRouteRequest(
  request: Request,
  edge: InternalServiceEdge,
  route: string
): Promise<NextResponse | InternalServiceCaller> {
  return authorizeInternalServiceRequest(request, edge, route, () =>
    authorizeInternalApiRequest(request, route)
  );
}
