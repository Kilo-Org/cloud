import {
  STS_ISSUERS,
  STS_SESSION_INGEST_SESSION_ACCESS_INVALIDATE,
  StsEnvironmentSchema,
  type StsEnvironment,
} from '@kilocode/sts-contracts';
import {
  createVerifier,
  failureResponse,
  httpJwksSource,
  type Verifier,
  type WaitUntil,
} from '@kilocode/verify';
import { callerLabel, observeInternalAuth } from '@kilocode/worker-utils/internal-auth-observation';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * Which credentials `POST /internal/session-access/invalidate` accepts (design 6.5, D59: web's
 * `INTERNAL_API_SECRET` in `X-Internal-Secret` moves to an STS service token in
 * `Authorization: Bearer`). The values are o11y's `ADMIN_CREDENTIAL_ACCEPT` values, and the set is
 * closed: any other value answers 500, never a default. Unset or empty means `legacy-only`, exactly
 * the check before this switch. Rollback is a redeploy with the value set back to `legacy-only`,
 * independent of web's own `SESSION_INGEST_SENDER_AUTH`. The other internal routes stay on the
 * shared secret and never read it.
 */
export const INVALIDATE_CREDENTIAL_ACCEPT_MODES = [
  'disabled',
  'legacy-only',
  'legacy-and-sts',
  'sts-only',
] as const;
export type InvalidateCredentialAcceptMode = (typeof INVALIDATE_CREDENTIAL_ACCEPT_MODES)[number];

type Acceptance = { legacy: boolean; sts: boolean };

const ACCEPTANCE: Readonly<Record<InvalidateCredentialAcceptMode, Acceptance>> = {
  disabled: { legacy: false, sts: false },
  'legacy-only': { legacy: true, sts: false },
  'legacy-and-sts': { legacy: true, sts: true },
  'sts-only': { legacy: false, sts: true },
};

function isAcceptMode(mode: string): mode is InvalidateCredentialAcceptMode {
  return Object.hasOwn(ACCEPTANCE, mode);
}

/** The credentials `mode` admits, or null when the value is outside the closed set. */
export function invalidateCredentialAcceptance(mode: string | undefined): Acceptance | null {
  if (mode === undefined || mode === '') return ACCEPTANCE['legacy-only'];
  return isAcceptMode(mode) ? ACCEPTANCE[mode] : null;
}

/**
 * The STS audience and scope of this route, granted to `web` only. The UTS user scopes under the
 * same audience (`session-ingest:sessions.*`) are a separate registry and never verify here.
 */
export const SESSION_INGEST_STS_AUDIENCE = STS_SESSION_INGEST_SESSION_ACCESS_INVALIDATE.audience;
export const SESSION_ACCESS_INVALIDATE_SCOPE = STS_SESSION_INGEST_SESSION_ACCESS_INVALIDATE.scope;

/** The one workload that sends to this route; STS grants its scope to it alone. */
export const INVALIDATE_SENDER = 'web';

/**
 * The counter label of this route for both credentials (design section 9.4, item 9): the label the
 * internal routes have always counted under, which saved queries and dashboards read. Only this
 * route admits STS, so an `sts` row under it is always this route.
 */
const INVALIDATE_ROUTE_LABEL = 'cloud_agent_internal';

/**
 * This Worker's origin in each STS environment: the RFC 9728 `resource` and the base of the
 * challenge's metadata URL. Fixed here, never read from the request. Staging is closed (no route,
 * no internal secret), so an STS mode with `STS_ENVIRONMENT=staging` answers 500.
 */
const RESOURCE_ORIGINS: Readonly<Partial<Record<StsEnvironment, string>>> = {
  production: 'https://ingest.kilosessions.ai',
  development: 'http://localhost:8800',
};

/** RFC 9728 protected-resource metadata path; every STS 401 challenge names it. */
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/**
 * The deployment settings this route reads, only from the Worker's own configuration:
 * `SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT` (default `legacy-only`) and `STS_ENVIRONMENT`, the
 * one `env` claim and issuer STS tokens must carry.
 */
export type InvalidateCredentialEnv = {
  SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT?: string;
  STS_ENVIRONMENT?: string;
};

type StsRouteConfig = { environment: StsEnvironment; origin: string };

/** The STS environment and this Worker's origin there, or the configuration error. No I/O. */
function stsRouteConfig(env: InvalidateCredentialEnv): StsRouteConfig | { error: string } {
  const environment = StsEnvironmentSchema.safeParse(env.STS_ENVIRONMENT);
  if (!environment.success) return { error: 'sts_environment' };
  const origin = RESOURCE_ORIGINS[environment.data];
  if (origin === undefined) return { error: 'resource_origin' };
  return { environment: environment.data, origin };
}

/**
 * `GET /.well-known/oauth-protected-resource` (RFC 9728): the document the STS challenge names,
 * only while the mode admits STS and its environment is configured; otherwise null, and the path
 * answers the Worker's ordinary 404. Built from configuration and code only.
 */
export function protectedResourceMetadata(env: InvalidateCredentialEnv): Response | null {
  const acceptance = invalidateCredentialAcceptance(
    env.SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT
  );
  if (acceptance?.sts !== true) return null;
  const config = stsRouteConfig(env);
  if ('error' in config) return null;
  return Response.json(
    {
      resource: config.origin,
      authorization_servers: [STS_ISSUERS[config.environment]],
      bearer_methods_supported: ['header'],
      scopes_supported: [SESSION_ACCESS_INVALIDATE_SCOPE],
    },
    { headers: { 'cache-control': 'public, max-age=300' } }
  );
}

const NO_STORE = { 'cache-control': 'no-store' };

function misconfigured(reason: string): Response {
  console.error(JSON.stringify({ event: 'session_access_invalidate_auth_misconfigured', reason }));
  return Response.json({ error: 'server_misconfigured' }, { status: 500, headers: NO_STORE });
}

function refusedLog(status: number, reason: string): void {
  // Never the credential: the status and the rule only.
  console.warn(JSON.stringify({ event: 'session_access_invalidate_sts_refused', status, reason }));
}

/**
 * The guard of `POST /internal/session-access/invalidate`. `legacy` is the shared-secret middleware
 * the route used before this switch; in `legacy-only` the guard is exactly that middleware and
 * builds and fetches nothing. Create it once at module scope: it holds one STS verifier per
 * environment, built on the first STS request, so its key set serves every later request.
 */
export function createInvalidateAuth<E extends { Bindings: InvalidateCredentialEnv }>(
  legacy: MiddlewareHandler<E>
): MiddlewareHandler<E> {
  const verifiers = new Map<StsEnvironment, Verifier<false>>();

  function verifierFor({ environment, origin }: StsRouteConfig): Verifier<false> {
    const held = verifiers.get(environment);
    if (held !== undefined) return held;
    const issuer = STS_ISSUERS[environment];
    // The key set comes from the issuer's own origin; the STS binding serves no key set.
    const verifier = createVerifier({
      audience: SESSION_INGEST_STS_AUDIENCE,
      environment,
      resourceMetadataUrl: `${origin}${RESOURCE_METADATA_PATH}`,
      // The registry is the default `STS_SCOPE_REGISTRY`, where the invalidation scope lives.
      sts: { issuer, jwks: httpJwksSource(issuer) },
    });
    verifiers.set(environment, verifier);
    return verifier;
  }

  /** The STS check alone: a refusal here is final and never reaches the shared secret. */
  async function stsCheck(
    c: Context<E>,
    authorization: string | null,
    config: StsRouteConfig
  ): Promise<Response | null> {
    const metadata = `resource_metadata="${config.origin}${RESOURCE_METADATA_PATH}"`;
    if (authorization !== null && c.req.header('X-Internal-Secret') !== undefined) {
      // Two credentials: answer neither, so no request is decided by the weaker one.
      refusedLog(400, 'mixed_credentials');
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
    const scope = SESSION_ACCESS_INVALIDATE_SCOPE;
    const result = await verifierFor(config).verify(
      authorization,
      { issuer: 'sts', scope },
      { waitUntil: waitUntilOf(c) }
    );
    if (!result.ok) {
      refusedLog(result.status, result.reason);
      return failureResponse(result);
    }
    const workload = result.caller.kind === 'service' ? result.caller.workload : null;
    if (workload !== INVALIDATE_SENDER) {
      refusedLog(403, 'workload_not_allowed');
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
    observeInternalAuth('session-ingest', INVALIDATE_ROUTE_LABEL, 'sts', callerLabel(workload));
    return null;
  }

  return async (c, next) => {
    const acceptance = invalidateCredentialAcceptance(
      c.env.SESSION_ACCESS_INVALIDATE_CREDENTIAL_ACCEPT
    );
    if (acceptance === null) return misconfigured('accept_mode');
    // The default: exactly the original check. No verifier, key set or new header read.
    if (acceptance.legacy && !acceptance.sts) return legacy(c, next);
    if (!acceptance.legacy && !acceptance.sts) {
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }

    // An STS bearer arrives only in `Authorization`; the shared secret only in `X-Internal-Secret`.
    // Without a bearer, `legacy-and-sts` runs the legacy check; `sts-only` never reads the secret.
    const authorization = c.req.header('Authorization') ?? null;
    if (authorization === null && acceptance.legacy) return legacy(c, next);

    const config = stsRouteConfig(c.env);
    if ('error' in config) return misconfigured(config.error);
    return (await stsCheck(c, authorization, config)) ?? (await next());
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
