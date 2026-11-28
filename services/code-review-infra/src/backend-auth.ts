import { timingSafeEqual } from '@kilocode/encryption';
import {
  STS_ISSUERS,
  StsEnvironmentSchema,
  type StsEnvironment,
  type StsScopeRegistry,
} from '@kilocode/sts-contracts';
import {
  createVerifier,
  failureResponse,
  httpJwksSource,
  type Verifier,
  type WaitUntil,
} from '@kilocode/verify';
import { backendAuthMiddleware, extractBearerToken } from '@kilocode/worker-utils';
import {
  INTERNAL_CALLER_HEADER,
  callerLabel,
  observeInternalAuth,
} from '@kilocode/worker-utils/internal-auth-observation';
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';

/**
 * Which credentials the review routes accept (design 6.5, D59: web's shared `BACKEND_AUTH_TOKEN`
 * bearer moves to an STS service token with the `code-review` audience). The values are o11y's
 * `ADMIN_CREDENTIAL_ACCEPT` values, and the set is closed: any other value answers 500 on the review
 * routes, never a default. Unset or empty means `legacy-only`, exactly the check before this switch.
 * Rollback is a redeploy with the value set back to `legacy-only`, independent of web's own
 * `CODE_REVIEW_WORKER_SENDER_AUTH`.
 */
export const BACKEND_CREDENTIAL_ACCEPT_MODES = [
  'disabled',
  'legacy-only',
  'legacy-and-sts',
  'sts-only',
] as const;
export type BackendCredentialAcceptMode = (typeof BACKEND_CREDENTIAL_ACCEPT_MODES)[number];

type Acceptance = { legacy: boolean; sts: boolean };

const ACCEPTANCE: Readonly<Record<BackendCredentialAcceptMode, Acceptance>> = {
  disabled: { legacy: false, sts: false },
  'legacy-only': { legacy: true, sts: false },
  'legacy-and-sts': { legacy: true, sts: true },
  'sts-only': { legacy: false, sts: true },
};

function isAcceptMode(mode: string): mode is BackendCredentialAcceptMode {
  return Object.hasOwn(ACCEPTANCE, mode);
}

/** The credentials `mode` admits, or null when the value is outside the closed set. */
export function backendCredentialAcceptance(mode: string | undefined): Acceptance | null {
  if (mode === undefined || mode === '') return ACCEPTANCE['legacy-only'];
  return isAcceptMode(mode) ? ACCEPTANCE[mode] : null;
}

// --- Pending registration in @kilocode/sts-contracts --------------------------------------------
// The registry-and-grants change adds these scopes to `STS_SCOPE_REGISTRY` and grants them to the
// `web` workload only; web's sender names the same strings (apps/web/src/lib/code-reviews/client/
// code-review-worker-client.ts). Until then STS mints no token for them, so the local registry
// below admits nothing STS has not signed. Once registered, use the contract constants and the
// default registry instead, and delete this block.
export const CODE_REVIEW_STS_AUDIENCE = 'code-review';
const CODE_REVIEW_STS_SCOPES = {
  dispatch: 'code-review:review.dispatch',
  statusRead: 'code-review:review.status-read',
  cancel: 'code-review:review.cancel',
  retryFresh: 'code-review:review.retry-fresh',
} as const;
const CODE_REVIEW_STS_SCOPE_REGISTRY: StsScopeRegistry = {
  [CODE_REVIEW_STS_AUDIENCE]: { scopes: Object.values(CODE_REVIEW_STS_SCOPES) },
};
// --- End of pending registration -------------------------------------------------------------

/** The one workload that sends to the review routes; STS grants their scopes to it alone. */
export const REVIEW_SENDER = 'web';

const REVIEW_ROUTE_NAMES = ['dispatch', 'statusRead', 'cancel', 'retryFresh'] as const;
export type ReviewRouteName = (typeof REVIEW_ROUTE_NAMES)[number];

/** One review route: as registered with Hono, its one STS scope and its counter label. */
type ReviewRoute = { method: 'GET' | 'POST'; path: string; scope: string; label: string };

/**
 * Each review route and its contract. `index.ts` registers each route under this method and path,
 * so the middleware finds a request's scope from the route Hono matched, never from a request value
 * of its own. The route repeats the workload check, so a policy change alone never opens a route.
 */
export const REVIEW_ROUTES: Readonly<Record<ReviewRouteName, ReviewRoute>> = {
  dispatch: {
    method: 'POST',
    path: '/review',
    scope: CODE_REVIEW_STS_SCOPES.dispatch,
    label: 'review_dispatch',
  },
  statusRead: {
    method: 'GET',
    path: '/reviews/:reviewId/status',
    scope: CODE_REVIEW_STS_SCOPES.statusRead,
    label: 'review_status_read',
  },
  cancel: {
    method: 'POST',
    path: '/reviews/:reviewId/cancel',
    scope: CODE_REVIEW_STS_SCOPES.cancel,
    label: 'review_cancel',
  },
  retryFresh: {
    method: 'POST',
    path: '/reviews/:reviewId/retry-fresh',
    scope: CODE_REVIEW_STS_SCOPES.retryFresh,
    label: 'review_retry_fresh',
  },
};

const RECEIVER = 'code-review-infra';

/** The counter label of `route`; `/health` and unmatched paths, never switched, are `other`. */
function routeLabel(route: ReviewRouteName | null): string {
  return route === null ? 'other' : REVIEW_ROUTES[route].label;
}

/**
 * This Worker's origin in each STS environment: the RFC 9728 `resource` and the base of the
 * challenge's metadata URL. Fixed here, never read from the request. Production is the script's
 * `workers.dev` address (it has no routes); development is the `wrangler dev` port. There is no
 * staging deployment, so an STS mode with `STS_ENVIRONMENT=staging` answers 500.
 */
const RESOURCE_ORIGINS: Readonly<Partial<Record<StsEnvironment, string>>> = {
  production: 'https://kilo-code-review-worker.engineering-e11.workers.dev',
  development: 'http://localhost:8789',
};

/** RFC 9728 protected-resource metadata path; every STS 401 challenge names it. */
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/**
 * The deployment settings the review routes read, only from the Worker's own configuration:
 * `BACKEND_CREDENTIAL_ACCEPT` (default `legacy-only`) and `STS_ENVIRONMENT`, the one `env` claim
 * and issuer STS tokens must carry.
 */
export type BackendCredentialEnv = {
  BACKEND_CREDENTIAL_ACCEPT?: string;
  STS_ENVIRONMENT?: string;
};

type StsRouteConfig = { environment: StsEnvironment; origin: string };

/** The STS environment and this Worker's origin there, or the configuration error. No I/O. */
function stsRouteConfig(env: BackendCredentialEnv): StsRouteConfig | { error: string } {
  const environment = StsEnvironmentSchema.safeParse(env.STS_ENVIRONMENT);
  if (!environment.success) return { error: 'sts_environment' };
  const origin = RESOURCE_ORIGINS[environment.data];
  if (origin === undefined) return { error: 'resource_origin' };
  return { environment: environment.data, origin };
}

/**
 * `GET /.well-known/oauth-protected-resource` (RFC 9728): the document the STS challenge names,
 * only while the mode admits STS and its environment is configured; otherwise null, and the path
 * behaves as any unmatched path. Built from configuration and code only.
 */
export function protectedResourceMetadata(env: BackendCredentialEnv): Response | null {
  if (backendCredentialAcceptance(env.BACKEND_CREDENTIAL_ACCEPT)?.sts !== true) return null;
  const config = stsRouteConfig(env);
  if ('error' in config) return null;
  return Response.json(
    {
      resource: config.origin,
      authorization_servers: [STS_ISSUERS[config.environment]],
      bearer_methods_supported: ['header'],
      scopes_supported: REVIEW_ROUTE_NAMES.map(name => REVIEW_ROUTES[name].scope),
    },
    { headers: { 'cache-control': 'public, max-age=300' } }
  );
}

const NO_STORE = { 'cache-control': 'no-store' };

function misconfigured(reason: string): Response {
  console.error(JSON.stringify({ event: 'code_review_backend_auth_misconfigured', reason }));
  return Response.json({ error: 'server_misconfigured' }, { status: 500, headers: NO_STORE });
}

function refusedLog(label: string, status: number, reason: string): void {
  // Never the credential: the route, the status and the rule only.
  console.warn(
    JSON.stringify({ event: 'code_review_backend_sts_refused', route: label, status, reason })
  );
}

/** The review route Hono matched for this request, or null for every other path. */
function reviewRouteOf(c: Context): ReviewRouteName | null {
  const handler = matchedRoutes(c).at(-1);
  if (handler === undefined) return null;
  return (
    REVIEW_ROUTE_NAMES.find(
      name =>
        REVIEW_ROUTES[name].method === handler.method && REVIEW_ROUTES[name].path === handler.path
    ) ?? null
  );
}

type MaybePromise<T> = T | Promise<T>;

/**
 * The guard of every path. `getSecret` reads `BACKEND_AUTH_TOKEN`, undefined when unavailable.
 * Create it once at module scope: it holds one STS verifier per environment, built on the first
 * STS request, so its key set serves every later request of the isolate. In `legacy-only` it is
 * the original `backendAuthMiddleware` check and builds and fetches nothing.
 *
 * `/health` and unmatched paths keep that original check in every mode: no scope names them.
 */
export function createBackendAuth<E extends { Bindings: BackendCredentialEnv }>(
  getSecret: (c: Context<E>) => MaybePromise<string | undefined>
): MiddlewareHandler<E> {
  // The original check, counted per route.
  const legacyOnly = backendAuthMiddleware<E>(getSecret, {
    receiver: RECEIVER,
    route: c => routeLabel(reviewRouteOf(c)),
  });
  const verifiers = new Map<StsEnvironment, Verifier<false>>();

  function verifierFor({ environment, origin }: StsRouteConfig): Verifier<false> {
    const held = verifiers.get(environment);
    if (held !== undefined) return held;
    const issuer = STS_ISSUERS[environment];
    // The key set comes from the issuer's own origin; the STS binding serves no key set.
    const verifier = createVerifier({
      audience: CODE_REVIEW_STS_AUDIENCE,
      environment,
      resourceMetadataUrl: `${origin}${RESOURCE_METADATA_PATH}`,
      sts: { issuer, jwks: httpJwksSource(issuer), scopeRegistry: CODE_REVIEW_STS_SCOPE_REGISTRY },
    });
    verifiers.set(environment, verifier);
    return verifier;
  }

  /**
   * Whether `authorization` carries exactly the shared secret, compared as `backendAuthMiddleware`
   * compares it. An unavailable or empty secret matches nothing, so the request goes to the STS
   * check.
   */
  async function isSharedSecret(c: Context<E>, authorization: string | null): Promise<boolean> {
    const secret = await getSecret(c);
    if (!secret || secret.trim() === '') return false;
    const bearer = extractBearerToken(authorization);
    return bearer !== null && timingSafeEqual(bearer, secret);
  }

  /** The STS check alone: a refusal here is final and never reaches the shared secret. */
  async function stsCheck(
    c: Context<E>,
    route: ReviewRouteName,
    authorization: string | null,
    config: StsRouteConfig
  ): Promise<Response | null> {
    const { scope } = REVIEW_ROUTES[route];
    const label = routeLabel(route);
    const result = await verifierFor(config).verify(
      authorization,
      { issuer: 'sts', scope },
      { waitUntil: waitUntilOf(c) }
    );
    if (!result.ok) {
      refusedLog(label, result.status, result.reason);
      return failureResponse(result);
    }
    const workload = result.caller.kind === 'service' ? result.caller.workload : null;
    if (workload !== REVIEW_SENDER) {
      refusedLog(label, 403, 'workload_not_allowed');
      return Response.json(
        { error: 'insufficient_scope', scope },
        {
          status: 403,
          headers: {
            ...NO_STORE,
            'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${config.origin}${RESOURCE_METADATA_PATH}"`,
          },
        }
      );
    }
    observeInternalAuth(RECEIVER, label, 'sts', callerLabel(workload));
    return null;
  }

  return async (c, next) => {
    const route = reviewRouteOf(c);
    if (route === null) return legacyOnly(c, next);
    const acceptance = backendCredentialAcceptance(c.env.BACKEND_CREDENTIAL_ACCEPT);
    if (acceptance === null) return misconfigured('accept_mode');
    // The default: exactly the original check. No verifier, key set or new header read.
    if (acceptance.legacy && !acceptance.sts) return legacyOnly(c, next);
    if (!acceptance.legacy && !acceptance.sts) return c.json({ error: 'Unauthorized' }, 401);

    // Both credentials arrive in `Authorization: Bearer`, so one request carries at most one. In
    // `legacy-and-sts` the shared secret is compared exactly first; every other value, a malformed
    // token included, goes to the STS check, whose refusal is final. `sts-only` never reads the
    // secret.
    const authorization = c.req.header('Authorization') ?? null;
    if (acceptance.legacy && (await isSharedSecret(c, authorization))) {
      observeInternalAuth(
        RECEIVER,
        routeLabel(route),
        'legacy_shared_secret',
        callerLabel(c.req.header(INTERNAL_CALLER_HEADER) ?? null)
      );
      return next();
    }
    const config = stsRouteConfig(c.env);
    if ('error' in config) return misconfigured(config.error);
    return (await stsCheck(c, route, authorization, config)) ?? (await next());
  };
}

/**
 * The request's `waitUntil`, or a no-op outside a request context (Hono's `executionCtx` getter
 * throws there, which is how unit tests call the routes); a key-set refresh then runs unkept.
 */
function waitUntilOf(c: Context): WaitUntil {
  try {
    const ctx = c.executionCtx;
    return promise => ctx.waitUntil(promise);
  } catch {
    return () => {};
  }
}
