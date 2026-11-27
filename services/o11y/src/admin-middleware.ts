import { timingSafeEqual } from '@kilocode/encryption';
import {
  STS_ISSUERS,
  STS_O11Y_ALERTING_READ,
  STS_O11Y_ALERTING_WRITE,
  STS_O11Y_API_METRICS_WRITE,
  StsEnvironmentSchema,
  type StsEnvironment,
} from '@kilocode/sts-contracts';
import { createVerifier, failureResponse, httpJwksSource, type Verifier } from '@kilocode/verify';
import {
  INTERNAL_CALLER_HEADER,
  callerLabel,
  observeInternalAuth,
} from '@kilocode/worker-utils/internal-auth-observation';
import type { Context, MiddlewareHandler } from 'hono';
import { SecretNotConfiguredError, readO11ySecret } from './secrets';

/**
 * Which admin credentials the admin routes accept (design 6.5: the shared
 * `O11Y_KILO_GATEWAY_CLIENT_SECRET` in `X-O11Y-ADMIN-TOKEN` moves to an STS service token with the
 * `o11y` audience). The set is closed: a value outside it refuses every request, never a default.
 * Unset means `legacy-only`, the behaviour before phase 4. Rollback is a redeploy with the value
 * set back to `legacy-only`, independent of `SECRETS_SOURCE` and of the callers' own switches.
 */
export const ADMIN_CREDENTIAL_ACCEPT_MODES = [
  'disabled',
  'legacy-only',
  'legacy-and-sts',
  'sts-only',
] as const;
export type AdminCredentialAcceptMode = (typeof ADMIN_CREDENTIAL_ACCEPT_MODES)[number];

type Acceptance = { legacy: boolean; sts: boolean };

const ACCEPTANCE: Readonly<Record<AdminCredentialAcceptMode, Acceptance>> = {
  disabled: { legacy: false, sts: false },
  'legacy-only': { legacy: true, sts: false },
  'legacy-and-sts': { legacy: true, sts: true },
  'sts-only': { legacy: false, sts: true },
};

function isAcceptMode(mode: string): mode is AdminCredentialAcceptMode {
  return Object.hasOwn(ACCEPTANCE, mode);
}

/** The credentials `mode` admits, or null when the value is outside the closed set. */
export function adminCredentialAcceptance(mode: string | undefined): Acceptance | null {
  if (mode === undefined || mode === '') return ACCEPTANCE['legacy-only'];
  return isAcceptMode(mode) ? ACCEPTANCE[mode] : null;
}

/** The STS audience of this Worker (design 6.5); all three o11y scopes belong to it. */
export const O11Y_STS_AUDIENCE = STS_O11Y_ALERTING_READ.audience;

export type AdminRoute = 'apiMetricsWrite' | 'alertingRead' | 'alertingWrite';

/** One admin route family's STS contract: its one scope and the STS workloads that may call it. */
export type AdminRouteContract = { scope: string; workloads: readonly string[] };

/**
 * Each admin route family's STS contract. STS policy grants the scope only to these workloads;
 * the route repeats the check, so a policy change alone never opens a route to another caller.
 */
export const ADMIN_ROUTES: Readonly<Record<AdminRoute, AdminRouteContract>> = {
  /** `POST /ingest/api-metrics`: the AI gateway's request metrics (also sent by the web app). */
  apiMetricsWrite: { scope: STS_O11Y_API_METRICS_WRITE.scope, workloads: ['ai-gateway', 'web'] },
  /** `GET /alerting/{config,baseline,ttfb-config,ttfb-baseline}`: the web admin pages. */
  alertingRead: { scope: STS_O11Y_ALERTING_READ.scope, workloads: ['web'] },
  /** `PUT` and `DELETE /alerting/{config,ttfb-config}`: the web admin pages. */
  alertingWrite: { scope: STS_O11Y_ALERTING_WRITE.scope, workloads: ['web'] },
};

/** The observation label of each admin route family (design section 9.4, item 9). */
const ADMIN_ROUTE_LABELS: Readonly<Record<AdminRoute, string>> = {
  apiMetricsWrite: 'api_metrics_write',
  alertingRead: 'alerting_read',
  alertingWrite: 'alerting_write',
};

/**
 * This Worker's origin in each STS environment: the RFC 9728 `resource` and the base of the
 * challenge's metadata URL. Fixed here, never read from the request. o11y has no isolated staging
 * deployment, so staging has none and an STS mode there answers 500 until that deployment exists.
 */
const RESOURCE_ORIGINS: Readonly<Partial<Record<StsEnvironment, string>>> = {
  production: 'https://o11y.kiloapps.io',
  development: 'http://localhost:8801',
};

/** RFC 9728 protected-resource metadata path; every STS 401 challenge names it. */
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/**
 * The deployment settings the admin routes read. `ADMIN_CREDENTIAL_ACCEPT` (default
 * `legacy-only`) and `STS_ENVIRONMENT` (the one `env` claim and issuer STS tokens must carry) are
 * read only from the Worker's own configuration.
 */
export type AdminCredentialEnv = {
  ADMIN_CREDENTIAL_ACCEPT?: string;
  STS_ENVIRONMENT?: string;
};

type StsRouteConfig = { environment: StsEnvironment; origin: string };

/**
 * The STS environment this deployment accepts tokens of and its fixed origin there, or the
 * configuration error. Configuration only: no request value, no I/O. The admin check and the
 * metadata route both read it, so the challenge never names a URL that answers 404.
 */
function stsRouteConfig(env: Env & AdminCredentialEnv): StsRouteConfig | { error: string } {
  const environment = StsEnvironmentSchema.safeParse(env.STS_ENVIRONMENT);
  if (!environment.success) return { error: 'sts_environment' };
  const origin = RESOURCE_ORIGINS[environment.data];
  if (origin === undefined) return { error: 'resource_origin' };
  return { environment: environment.data, origin };
}

/**
 * `GET /.well-known/oauth-protected-resource` (RFC 9728): the metadata the STS challenge names,
 * only while an STS mode is on and its environment is configured; otherwise null, and the route
 * answers the Worker's ordinary 404. It lists this Worker's origin, its STS issuer and the o11y
 * scopes, all from configuration and code.
 */
export function protectedResourceMetadata(env: Env & AdminCredentialEnv): Response | null {
  if (adminCredentialAcceptance(env.ADMIN_CREDENTIAL_ACCEPT)?.sts !== true) return null;
  const config = stsRouteConfig(env);
  if ('error' in config) return null;
  return Response.json(
    {
      resource: config.origin,
      authorization_servers: [STS_ISSUERS[config.environment]],
      bearer_methods_supported: ['header'],
      scopes_supported: Object.values(ADMIN_ROUTES).map(route => route.scope),
    },
    { headers: { 'cache-control': 'public, max-age=300' } }
  );
}

const NO_STORE = { 'cache-control': 'no-store' };

function unauthorized(c: Context): Response {
  return c.json({ success: false, error: 'Unauthorized' }, 401);
}

function misconfigured(reason: string): Response {
  console.error(JSON.stringify({ event: 'o11y_admin_auth_misconfigured', reason }));
  return Response.json({ error: 'server_misconfigured' }, { status: 500, headers: NO_STORE });
}

function refusedLog(route: AdminRoute, status: number, reason: string): void {
  // Never the credential: the route family, the status and the rule only.
  console.warn(JSON.stringify({ event: 'o11y_admin_sts_refused', route, status, reason }));
}

/** The pre-phase-4 check, unchanged: the shared secret in `X-O11Y-ADMIN-TOKEN`. */
async function legacyCheck(
  c: Context<{ Bindings: Env }>,
  route: AdminRoute
): Promise<Response | null> {
  let secret: string;
  try {
    secret = await readO11ySecret(c.env, 'O11Y_KILO_GATEWAY_CLIENT_SECRET', c.executionCtx);
  } catch (error) {
    if (error instanceof SecretNotConfiguredError) return unauthorized(c);
    throw error;
  }
  const token = c.req.header('X-O11Y-ADMIN-TOKEN');
  if (!secret || !token || !timingSafeEqual(token, secret)) return unauthorized(c);
  observeInternalAuth(
    'o11y',
    ADMIN_ROUTE_LABELS[route],
    'legacy_shared_secret',
    callerLabel(c.req.header(INTERNAL_CALLER_HEADER) ?? null)
  );
  return null;
}

export type AdminAuth = {
  /** The middleware of one admin route family; a plain function, safe to destructure. */
  requireAdmin: (route: AdminRoute) => MiddlewareHandler<{ Bindings: Env }>;
};

/**
 * The admin-route guard. Create it at module scope: it holds one STS verifier per environment,
 * built on the first STS request, so its key set serves every later request of the isolate. In
 * `legacy-only` it builds nothing and fetches nothing.
 */
export function createAdminAuth(): AdminAuth {
  const verifiers = new Map<StsEnvironment, Verifier<false>>();

  function verifierFor(environment: StsEnvironment, origin: string): Verifier<false> {
    const held = verifiers.get(environment);
    if (held !== undefined) return held;
    const issuer = STS_ISSUERS[environment];
    // The key set comes from the issuer's own origin. A service binding cannot reach it: STS
    // exposes only `SecretsBroker` to other Workers, which serves no key set.
    const verifier = createVerifier({
      audience: O11Y_STS_AUDIENCE,
      environment,
      resourceMetadataUrl: `${origin}${RESOURCE_METADATA_PATH}`,
      // The registry is the default `STS_SCOPE_REGISTRY`, where the three o11y scopes live.
      sts: { issuer, jwks: httpJwksSource(issuer) },
    });
    verifiers.set(environment, verifier);
    return verifier;
  }

  /**
   * The STS check alone; a refusal here is final and never reaches the shared secret. A request
   * without `Authorization` gets the bare 401 challenge.
   */
  async function stsCheck(
    c: Context<{ Bindings: Env }>,
    route: AdminRoute,
    environment: StsEnvironment,
    origin: string
  ): Promise<Response | null> {
    const metadata = `resource_metadata="${origin}${RESOURCE_METADATA_PATH}"`;
    const authorization = c.req.header('Authorization') ?? null;
    if (authorization !== null && c.req.header('X-O11Y-ADMIN-TOKEN') !== undefined) {
      // Two credentials: answer neither, so no request is decided by the weaker one.
      refusedLog(route, 400, 'mixed_credentials');
      return Response.json(
        { error: 'invalid_request' },
        {
          status: 400,
          headers: {
            ...NO_STORE,
            'www-authenticate': `Bearer error="invalid_request", ${metadata}`,
          },
        }
      );
    }
    const { scope, workloads } = ADMIN_ROUTES[route];
    const result = await verifierFor(environment, origin).verify(
      authorization,
      { issuer: 'sts', scope },
      { waitUntil: promise => c.executionCtx.waitUntil(promise) }
    );
    if (!result.ok) {
      refusedLog(route, result.status, result.reason);
      return failureResponse(result);
    }
    const workload = result.caller.kind === 'service' ? result.caller.workload : null;
    if (workload === null || !workloads.includes(workload)) {
      refusedLog(route, 403, 'workload_not_allowed');
      return Response.json(
        { error: 'insufficient_scope', scope },
        {
          status: 403,
          headers: {
            ...NO_STORE,
            'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}", ${metadata}`,
          },
        }
      );
    }
    observeInternalAuth('o11y', ADMIN_ROUTE_LABELS[route], 'sts', callerLabel(workload));
    return null;
  }

  return {
    requireAdmin: route => {
      return async (c, next) => {
        const env: Env & AdminCredentialEnv = c.env;
        const acceptance = adminCredentialAcceptance(env.ADMIN_CREDENTIAL_ACCEPT);
        if (acceptance === null) return misconfigured('accept_mode');
        // The default: exactly the pre-phase-4 path. No verifier, key set or new header read.
        if (acceptance.legacy && !acceptance.sts) {
          return (await legacyCheck(c, route)) ?? (await next());
        }
        if (!acceptance.legacy && !acceptance.sts) return unauthorized(c);

        // An STS bearer arrives only in `Authorization`; the shared secret only in its own
        // header. Without a bearer, `legacy-and-sts` runs the legacy path; `sts-only` never reads
        // the secret.
        if (c.req.header('Authorization') === undefined && acceptance.legacy) {
          return (await legacyCheck(c, route)) ?? (await next());
        }

        const config = stsRouteConfig(env);
        if ('error' in config) return misconfigured(config.error);
        return (await stsCheck(c, route, config.environment, config.origin)) ?? (await next());
      };
    },
  };
}

/** The admin-route middleware of each route family, with this Worker's own configuration. */
export const { requireAdmin } = createAdminAuth();
