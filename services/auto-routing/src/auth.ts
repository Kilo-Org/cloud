import {
  STS_ISSUERS,
  StsEnvironmentSchema,
  type StsEnvironment,
  type StsScopeRegistry,
} from '@kilocode/sts-contracts';
import { createVerifier, failureResponse, httpJwksSource, type Verifier } from '@kilocode/verify';
import { backendAuthMiddleware } from '@kilocode/worker-utils';
import { callerLabel, observeInternalAuth } from '@kilocode/worker-utils/internal-auth-observation';
import type { Context, MiddlewareHandler } from 'hono';
import type { HonoEnv } from './hono-env';
import { readAutoRoutingSecret, requestContext } from './secrets';

/**
 * Which credentials the internal routes (`/admin/*` and `POST /decide`) accept (design 6.5,
 * decision D59: the shared `INTERNAL_API_SECRET` bearer moves to an STS service token with the
 * `auto-routing` audience). The values and their meaning are o11y's
 * (`services/o11y/src/admin-middleware.ts`):
 * - absent, empty or `legacy-only`: the shared secret only, exactly as before. No verifier is
 *   built and no key set is fetched;
 * - `legacy-and-sts`: the shared secret, or an STS token of the route's scope;
 * - `sts-only`: only an STS token; the shared secret is never read;
 * - `disabled`: every request to these routes is refused.
 * Any other value refuses every such request with 500, never a default. Rollback is a redeploy with
 * the value unset or `legacy-only`. Other paths (`/health`) keep the shared secret in every mode.
 */
export const INTERNAL_CREDENTIAL_ACCEPT_MODES = [
  'disabled',
  'legacy-only',
  'legacy-and-sts',
  'sts-only',
] as const;
export type InternalCredentialAcceptMode = (typeof INTERNAL_CREDENTIAL_ACCEPT_MODES)[number];

type Acceptance = { legacy: boolean; sts: boolean };

const ACCEPTANCE: Readonly<Record<InternalCredentialAcceptMode, Acceptance>> = {
  disabled: { legacy: false, sts: false },
  'legacy-only': { legacy: true, sts: false },
  'legacy-and-sts': { legacy: true, sts: true },
  'sts-only': { legacy: false, sts: true },
};

function isAcceptMode(mode: string): mode is InternalCredentialAcceptMode {
  return Object.hasOwn(ACCEPTANCE, mode);
}

/** The credentials `mode` admits, or null when the value is outside the closed set. */
export function internalCredentialAcceptance(mode: string | undefined): Acceptance | null {
  if (mode === undefined || mode === '') return ACCEPTANCE['legacy-only'];
  return isAcceptMode(mode) ? ACCEPTANCE[mode] : null;
}

// --- Scopes pending registration in @kilocode/sts-contracts. ----------------------------------
// Once registered, import them from @kilocode/sts-contracts and delete this block. Until then the
// verifier's default registry refuses them, so no STS token can pass here even if a mode allowed it.
export const STS_AUTO_ROUTING_ADMIN_READ = {
  audience: 'auto-routing',
  scope: 'auto-routing:admin.read',
} as const;
export const STS_AUTO_ROUTING_ADMIN_WRITE = {
  audience: 'auto-routing',
  scope: 'auto-routing:admin.write',
} as const;
export const STS_AUTO_ROUTING_DECIDE = {
  audience: 'auto-routing',
  scope: 'auto-routing:decide',
} as const;
// --- End of scopes pending registration. -------------------------------------------------------

/** The STS audience of this Worker; every scope above belongs to it. */
export const AUTO_ROUTING_STS_AUDIENCE = STS_AUTO_ROUTING_DECIDE.audience;

/** The counter's receiver label (`INTERNAL_CALLERS`). */
const RECEIVER = 'auto-routing';

export type RouteFamily = 'adminRead' | 'adminWrite' | 'decide';

/**
 * One route family's STS contract: its one scope, the STS workloads that may call it, and its
 * observation label (design section 9.4, item 9). STS policy grants the scope only to these
 * workloads; the route repeats the check, so a policy change alone never opens a route.
 */
export type RouteContract = { scope: string; workloads: readonly string[]; label: string };

export const ROUTE_CONTRACTS: Readonly<Record<RouteFamily, RouteContract>> = {
  /** The web admin pages and the web routing-mode API read the classifier and routing settings. */
  adminRead: { scope: STS_AUTO_ROUTING_ADMIN_READ.scope, workloads: ['web'], label: 'admin_read' },
  /** The same web routes change them. */
  adminWrite: {
    scope: STS_AUTO_ROUTING_ADMIN_WRITE.scope,
    workloads: ['web'],
    label: 'admin_write',
  },
  /** The AI gateway's LLM proxy asks for a routing decision. */
  decide: { scope: STS_AUTO_ROUTING_DECIDE.scope, workloads: ['ai-gateway'], label: 'decide' },
};

/** Every route this guard governs, method and path exactly as `src/index.ts` registers them. */
export const GOVERNED_ROUTES: readonly { method: string; path: string; family: RouteFamily }[] = [
  { method: 'GET', path: '/admin/classifier-model', family: 'adminRead' },
  { method: 'PUT', path: '/admin/classifier-model', family: 'adminWrite' },
  { method: 'GET', path: '/admin/routing-mode', family: 'adminRead' },
  { method: 'PUT', path: '/admin/routing-mode', family: 'adminWrite' },
  { method: 'GET', path: '/admin/classifier-analytics', family: 'adminRead' },
  { method: 'POST', path: '/decide', family: 'decide' },
];

/** The family of a request, or null; HEAD reaches the GET handler. */
export function routeFamily(method: string, path: string): RouteFamily | null {
  const routeMethod = method === 'HEAD' ? 'GET' : method;
  const route = GOVERNED_ROUTES.find(r => r.method === routeMethod && r.path === path);
  return route?.family ?? null;
}

/**
 * This Worker's origin in each STS environment: the RFC 9728 `resource` and the base of the
 * challenge's metadata URL. Fixed here, never read from the request. auto-routing has no staging
 * deployment, so an STS mode there answers 500 until one exists.
 */
const RESOURCE_ORIGINS: Readonly<Partial<Record<StsEnvironment, string>>> = {
  production: 'https://auto-routing.kiloapps.io',
  development: 'http://localhost:8810',
};

/** RFC 9728 protected-resource metadata path; every STS 401 challenge names it. */
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/**
 * The deployment settings this guard reads, only from the Worker's own configuration:
 * `INTERNAL_CREDENTIAL_ACCEPT` (above) and `STS_ENVIRONMENT`, the one `env` claim and issuer STS
 * tokens must carry.
 */
export type InternalCredentialEnv = {
  INTERNAL_CREDENTIAL_ACCEPT?: string;
  STS_ENVIRONMENT?: string;
};

type StsRouteConfig = { environment: StsEnvironment; origin: string };

function stsRouteConfig(env: InternalCredentialEnv): StsRouteConfig | { error: string } {
  const environment = StsEnvironmentSchema.safeParse(env.STS_ENVIRONMENT);
  if (!environment.success) return { error: 'sts_environment' };
  const origin = RESOURCE_ORIGINS[environment.data];
  if (origin === undefined) return { error: 'resource_origin' };
  return { environment: environment.data, origin };
}

/**
 * `GET /.well-known/oauth-protected-resource` (RFC 9728): the metadata the STS challenge names,
 * only while the switch admits STS and its environment is configured; otherwise null.
 */
export function protectedResourceMetadata(env: Env & InternalCredentialEnv): Response | null {
  if (internalCredentialAcceptance(env.INTERNAL_CREDENTIAL_ACCEPT)?.sts !== true) return null;
  const config = stsRouteConfig(env);
  if ('error' in config) return null;
  return Response.json(
    {
      resource: config.origin,
      authorization_servers: [STS_ISSUERS[config.environment]],
      bearer_methods_supported: ['header'],
      scopes_supported: Object.values(ROUTE_CONTRACTS).map(contract => contract.scope),
    },
    { headers: { 'cache-control': 'public, max-age=300' } }
  );
}

/** A compact JWS bearer, the only form an STS token takes (usage-ingest's `JWS_BEARER`). */
const JWS_BEARER = /^Bearer +[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+ *$/i;

const NO_STORE = { 'cache-control': 'no-store' };

function unauthorized(c: Context<HonoEnv>): Response {
  return c.json({ error: 'Unauthorized' }, 401);
}

function misconfigured(reason: string): Response {
  console.error(JSON.stringify({ event: 'auto_routing_internal_auth_misconfigured', reason }));
  return Response.json({ error: 'server_misconfigured' }, { status: 500, headers: NO_STORE });
}

function refusedLog(route: string, status: number, reason: string): void {
  // Never the credential: the route family, the status and the rule only.
  console.warn(JSON.stringify({ event: 'auto_routing_sts_refused', route, status, reason }));
}

/** The counter label of a legacy admission; an unlisted path keeps the label it had before. */
function legacyLabel(c: Context<HonoEnv>): string {
  const family = routeFamily(c.req.method, c.req.path);
  if (family !== null) return ROUTE_CONTRACTS[family].label;
  return c.req.path.startsWith('/admin/') ? 'admin' : 'decide';
}

export type AuthOptions = {
  /** Tests only: the STS scope registry; production uses `STS_SCOPE_REGISTRY`. */
  scopeRegistry?: StsScopeRegistry;
};

/**
 * The internal-route guard. Create it at module scope: it holds one STS verifier per environment,
 * built on the first STS request, so its key set serves every later request of the isolate.
 */
export function createAuthMiddleware(options: AuthOptions = {}): MiddlewareHandler<HonoEnv> {
  // The shared-secret check, unchanged: `Authorization: Bearer <INTERNAL_API_SECRET>`.
  const legacy = backendAuthMiddleware<HonoEnv>(
    c => readAutoRoutingSecret(c.env, 'INTERNAL_API_SECRET', requestContext(c)),
    { receiver: RECEIVER, route: legacyLabel }
  );
  const verifiers = new Map<StsEnvironment, Verifier<false>>();

  function verifierFor({ environment, origin }: StsRouteConfig): Verifier<false> {
    const held = verifiers.get(environment);
    if (held !== undefined) return held;
    const issuer = STS_ISSUERS[environment];
    // The key set comes from the issuer's own origin: STS exposes only `SecretsBroker` to other
    // Workers over a binding, which serves no key set.
    const verifier = createVerifier({
      audience: AUTO_ROUTING_STS_AUDIENCE,
      environment,
      resourceMetadataUrl: `${origin}${RESOURCE_METADATA_PATH}`,
      sts: {
        issuer,
        jwks: httpJwksSource(issuer),
        ...(options.scopeRegistry ? { scopeRegistry: options.scopeRegistry } : {}),
      },
    });
    verifiers.set(environment, verifier);
    return verifier;
  }

  /** The STS check alone; a refusal here is final and never reaches the shared secret. */
  async function stsCheck(
    c: Context<HonoEnv>,
    family: RouteFamily,
    config: StsRouteConfig,
    authorization: string | null
  ): Promise<Response | null> {
    const { scope, workloads, label } = ROUTE_CONTRACTS[family];
    const ctx = requestContext(c);
    const result = await verifierFor(config).verify(
      authorization,
      { issuer: 'sts', scope },
      { waitUntil: promise => (ctx ? ctx.waitUntil(promise) : void promise) }
    );
    if (!result.ok) {
      refusedLog(label, result.status, result.reason);
      return failureResponse(result);
    }
    const workload = result.caller.kind === 'service' ? result.caller.workload : null;
    if (workload === null || !workloads.includes(workload)) {
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
    // Paths outside the switch (`/health`) keep the shared secret in every mode.
    if (!c.req.path.startsWith('/admin/') && c.req.path !== '/decide') return legacy(c, next);
    const env: Env & InternalCredentialEnv = c.env;
    const acceptance = internalCredentialAcceptance(env.INTERNAL_CREDENTIAL_ACCEPT);
    if (acceptance === null) return misconfigured('accept_mode');
    // The default: exactly the shared-secret path. No verifier, key set or new header read.
    if (acceptance.legacy && !acceptance.sts) return legacy(c, next);
    if (!acceptance.legacy && !acceptance.sts) return unauthorized(c);

    const authorization = c.req.header('Authorization') ?? null;
    // Both credentials travel in `Authorization`, so a request carries two only as a repeated or
    // comma-joined header. Answer neither, so no request is decided by the weaker one.
    if (authorization?.includes(',')) {
      refusedLog(legacyLabel(c), 400, 'mixed_credentials');
      return Response.json({ error: 'invalid_request' }, { status: 400, headers: NO_STORE });
    }
    // Under `legacy-and-sts`, a bearer that is not a compact JWS is the shared secret or nothing.
    if (acceptance.legacy && (authorization === null || !JWS_BEARER.test(authorization))) {
      return legacy(c, next);
    }

    const family = routeFamily(c.req.method, c.req.path);
    if (family === null) {
      refusedLog(legacyLabel(c), 401, 'no_route_scope');
      return unauthorized(c);
    }
    const config = stsRouteConfig(env);
    if ('error' in config) return misconfigured(config.error);
    return (await stsCheck(c, family, config, authorization)) ?? (await next());
  };
}

export const authMiddleware = createAuthMiddleware();
