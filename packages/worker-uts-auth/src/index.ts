import {
  UTS_ENDPOINTS,
  UtsEnvironmentSchema,
  feedReaderSources,
  resourceOriginOf,
  utsScopeEntry,
  type FeedReaderBinding,
  type UtsEnvironment,
  type UtsScopeEntry as UtsRegistryEntry,
} from '@kilocode/uts-contracts';
import {
  PAT_PREFIX,
  createVerifier,
  failureResponse,
  type UtsScopeRegistry,
  type Verifier,
  type VerifySuccess,
  type WaitUntil,
} from '@kilocode/verify';

/** The verified claims of a UTS access token. */
export type UtsAccessTokenClaims = Extract<VerifySuccess, { credential: 'access_token' }>['claims'];

/**
 * Which bearer families a Worker's user routes accept (design 9.1, 9.5). The set is closed: a
 * value outside it is a configuration error that refuses every bearer, never a default. Unset means
 * `legacy-only`, the behaviour before phase 4.
 */
export const USER_BEARER_ACCEPT_MODES = [
  'disabled',
  'legacy-only',
  'legacy-and-uts',
  'uts-only',
] as const;
export type UserBearerAcceptMode = (typeof USER_BEARER_ACCEPT_MODES)[number];

export type UserBearerAcceptance = { legacy: boolean; uts: boolean };

const ACCEPTANCE: Readonly<Record<UserBearerAcceptMode, UserBearerAcceptance>> = {
  disabled: { legacy: false, uts: false },
  'legacy-only': { legacy: true, uts: false },
  'legacy-and-uts': { legacy: true, uts: true },
  'uts-only': { legacy: false, uts: true },
};

function isAcceptMode(mode: string): mode is UserBearerAcceptMode {
  return Object.hasOwn(ACCEPTANCE, mode);
}

/** The families `mode` admits, or null when the value is outside the closed set. */
export function userBearerAcceptance(mode: string | undefined): UserBearerAcceptance | null {
  if (mode === undefined || mode === '') return ACCEPTANCE['legacy-only'];
  return isAcceptMode(mode) ? ACCEPTANCE[mode] : null;
}

function base64UrlJson(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
}

/**
 * The family a bearer belongs to, read from its shape before any verification, so each credential
 * reaches exactly one verifier: a `kilo_pat_` PAT or a compact JWS whose header names `EdDSA` and
 * `typ: at+jwt` is UTS; every other bearer is legacy, which verifies HS256 only. A failure in one
 * family never retries in the other.
 */
export function userBearerFamily(token: string): 'legacy' | 'uts' {
  if (token.startsWith(PAT_PREFIX)) return 'uts';
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] === undefined) return 'legacy';
  const header = base64UrlJson(parts[0]);
  return typeof header === 'object' &&
    header !== null &&
    'alg' in header &&
    header.alg === 'EdDSA' &&
    'typ' in header &&
    header.typ === 'at+jwt'
    ? 'uts'
    : 'legacy';
}

/**
 * The UTS environment of a Worker deployment, from its own `WORKER_ENV` or `ENVIRONMENT` var, never
 * from a request. Any other value has no UTS issuer, so the Worker accepts no UTS token.
 */
export function utsEnvironmentOf(value: string | undefined): UtsEnvironment | null {
  const parsed = UtsEnvironmentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The binding of the feed Worker's `FeedReader` entrypoint (`props.caller` = the Worker's own
 * deployed name). Phase 3 serves the key set beside the feed, so a key-set refresh reads only the
 * key set, and the cold-start bootstrap reads all three at once.
 */
export type UtsFeedBinding = FeedReaderBinding;

/** What one Worker deployment configures for its user routes. */
export type UserBearerEnv = {
  /** `USER_BEARER_ACCEPT`. */
  mode: string | undefined;
  /** `WORKER_ENV` or `ENVIRONMENT`. */
  environment: string | undefined;
  /** `UTS_FEED`; absent in a deployment that has no feed binding. */
  feed: UtsFeedBinding | undefined;
};

/** A deployment whose UTS configuration is complete. */
type UtsConfig = { environment: UtsEnvironment; resourceOrigin: string; feed: UtsFeedBinding };

/**
 * One user route's UTS contract, fixed in route code. `requiresSession` is explicit on the route,
 * whatever the registry says. `org` decides the organization claim: `forbidden` for a route that
 * acts for the user alone, `required` for a route that acts in the token's organization (and, when
 * the request names one, only in that organization).
 */
export type UtsUserRoute = {
  scope: string;
  requiresSession: true;
  org: 'forbidden' | 'required';
};

export type UtsUserCaller = {
  userId: string;
  clientId: string;
  org: string | null;
  sessionId: string;
};

export type UserBearerDecision =
  /** Run the route's legacy path unchanged. */
  | { kind: 'legacy' }
  /** A verified UTS user token; `claims` are the verified claims (`iat`, `exp`, `sid`, ...). */
  | { kind: 'uts'; caller: UtsUserCaller; claims: UtsAccessTokenClaims }
  /** The answer to send: status, headers (`WWW-Authenticate`, `Retry-After`) and body. */
  | { kind: 'refused'; response: Response; reason: string };

export type UtsUserGateConfig<Route extends string> = {
  /** The Worker's audience: the part before the colon of each route scope. */
  audience: string;
  routes: Readonly<Record<Route, UtsUserRoute>>;
  /**
   * The RFC 9728 resource of this audience in an environment: phase 3's `UTS_RESOURCE_ORIGINS`
   * unless a test passes its own. An environment that names none accepts no UTS token.
   */
  resourceOriginOf?: (environment: UtsEnvironment) => string | null;
  /** The UTS scope registry; the phase 3 registry unless a test passes its own. */
  scopeRegistry?: (scope: string) => UtsRegistryEntry | null;
};

export type UtsUserGate<Route extends string> = {
  /**
   * Decides how a request's bearer is checked. `token` is the bearer the Worker's own extractor
   * read (null when the request has none). `waitUntil` is the request's own. `requestOrg` is the
   * organization the request names, for a route with `org: 'required'` that reads one; the
   * token's organization must then equal it.
   */
  decide(
    token: string | null,
    env: UserBearerEnv,
    route: Route,
    waitUntil: WaitUntil,
    requestOrg?: string
  ): Promise<UserBearerDecision>;
  /** `GET /.well-known/oauth-protected-resource`: RFC 9728 metadata, or 404 while UTS is off. */
  metadata(env: UserBearerEnv): Response;
};

/** RFC 9728 metadata path; the challenge of every UTS 401 names it. */
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

const NO_STORE = { 'cache-control': 'no-store' };

/** A refusal without a challenge: the organization refusals and the configuration errors. */
function refused(status: number, error: string, reason: string): UserBearerDecision {
  return {
    kind: 'refused',
    reason,
    response: Response.json({ error }, { status, headers: NO_STORE }),
  };
}

/**
 * A refusal with an RFC 6750 challenge, in the verifier's shape: 401 `invalid_token`, or 403
 * `insufficient_scope` naming the route scope. `resource_metadata` is named only when the
 * deployment serves its metadata, so a challenge never points at a 404.
 */
function challenged(
  reason: string,
  metadataUrl: string | null,
  insufficientScope?: string
): UserBearerDecision {
  const error = insufficientScope === undefined ? 'invalid_token' : 'insufficient_scope';
  const params = [
    `error="${error}"`,
    ...(insufficientScope === undefined ? [] : [`scope="${insufficientScope}"`]),
    ...(metadataUrl === null ? [] : [`resource_metadata="${metadataUrl}"`]),
  ];
  return {
    kind: 'refused',
    reason,
    response: Response.json(
      insufficientScope === undefined ? { error } : { error, scope: insufficientScope },
      {
        status: insufficientScope === undefined ? 401 : 403,
        headers: { ...NO_STORE, 'www-authenticate': `Bearer ${params.join(', ')}` },
      }
    ),
  };
}

function misconfigured(reason: string): UserBearerDecision {
  console.error(JSON.stringify({ event: 'user_bearer.misconfigured', reason }));
  return refused(500, 'server_misconfigured', reason);
}

/**
 * The user-route gate of one Worker. Create it at module scope: it holds one verifier per UTS
 * environment, built on first use, so its key set and feed copy serve every later request of the
 * isolate. Mode `legacy-only` builds nothing and calls nothing.
 */
export function createUtsUserGate<Route extends string>(
  config: UtsUserGateConfig<Route>
): UtsUserGate<Route> {
  for (const route of Object.values<UtsUserRoute>(config.routes)) {
    if (!route.scope.startsWith(`${config.audience}:`)) {
      throw new Error(`route scope ${route.scope} is not a scope of ${config.audience}`);
    }
  }
  const originOf =
    config.resourceOriginOf ??
    ((environment: UtsEnvironment) => resourceOriginOf(environment, config.audience));
  const registry = config.scopeRegistry ?? utsScopeEntry;
  const scopeRegistry: UtsScopeRegistry = (audience, scope) => {
    const entry = registry(scope);
    return entry !== null && entry.audience === audience
      ? { requiresSession: entry.requiresSession, patEligible: entry.patEligible }
      : null;
  };
  const verifiers = new Map<UtsEnvironment, Verifier<false>>();

  /**
   * The environment's verifier. The first request of the isolate supplies the feed binding; the
   * binding is the Worker's own, so every later request would supply the same one.
   */
  function verifierFor(configured: UtsConfig): Verifier<false> {
    const held = verifiers.get(configured.environment);
    if (held !== undefined) return held;
    const sources = feedReaderSources(configured.feed);
    // UTS issuer only and no PAT port: an STS token fails its issuer check and a PAT gets 401.
    // The library refuses a token whose `env` claim is not this environment.
    const verifier = createVerifier({
      audience: config.audience,
      environment: configured.environment,
      resourceMetadataUrl: `${configured.resourceOrigin}${RESOURCE_METADATA_PATH}`,
      uts: {
        issuer: UTS_ENDPOINTS[configured.environment].issuer,
        // The key-set refresh reads only the key set; the cold-start bootstrap reads all three.
        jwks: sources.jwks,
        revocation: sources.feed,
        bootstrap: sources.bootstrap,
        scopeRegistry,
      },
    });
    verifiers.set(configured.environment, verifier);
    return verifier;
  }

  async function verifyUts(
    token: string,
    configured: UtsConfig,
    route: UtsUserRoute,
    waitUntil: WaitUntil,
    requestOrg: string | undefined
  ): Promise<UserBearerDecision> {
    if (requestOrg !== undefined && route.org === 'forbidden') {
      throw new Error(`route ${route.scope} acts for the user alone and reads no organization`);
    }
    const metadataUrl = `${configured.resourceOrigin}${RESOURCE_METADATA_PATH}`;
    const result = await verifierFor(configured).verify(
      `Bearer ${token}`,
      {
        issuer: 'uts',
        scope: route.scope,
        requiresSession: route.requiresSession,
        ...(requestOrg !== undefined && { org: requestOrg }),
      },
      { waitUntil }
    );
    if (!result.ok) {
      return { kind: 'refused', reason: result.reason, response: failureResponse(result) };
    }
    // The verifier has no STS issuer and no PAT port, so a success is a UTS user access token;
    // the checks below hold the route's caller contract even if that changes.
    if (result.credential !== 'access_token' || result.caller.kind !== 'user') {
      return challenged('caller_kind', metadataUrl);
    }
    const caller = result.caller;
    if (caller.sessionId === null) return challenged('session_required', metadataUrl);
    // No route of these Workers accepts a token that acts for a user on another party's behalf.
    if (caller.actor !== null) return challenged('delegation', metadataUrl, route.scope);
    if (route.org === 'forbidden' && caller.org !== null) {
      return refused(403, 'org_mismatch', 'org_forbidden');
    }
    // A route that names no request organization still needs the token's own. With `requestOrg`
    // the library already refused a missing or different one; the route repeats that check, as it
    // repeats the registry checks below, so a token never acts in an organization it does not name.
    if (route.org === 'required' && caller.org === null) {
      return refused(403, 'org_mismatch', 'org_required');
    }
    if (requestOrg !== undefined && caller.org !== requestOrg) {
      return refused(403, 'org_mismatch', 'org_mismatch');
    }
    // The registry names the clients that may hold the scope and caps its token lifetime; UTS
    // enforces both at mint, and the route repeats them so a registry change reaches both sides.
    const entry = registry(route.scope);
    if (entry === null || !entry.allowedClients.includes(caller.clientId)) {
      return challenged('client_not_allowed', metadataUrl, route.scope);
    }
    if (result.claims.exp - result.claims.iat > entry.maxLifetimeSeconds) {
      return challenged('lifetime', metadataUrl);
    }
    return {
      kind: 'uts',
      claims: result.claims,
      caller: {
        userId: caller.subject,
        clientId: caller.clientId,
        org: caller.org,
        sessionId: caller.sessionId,
      },
    };
  }

  /** The configured UTS environment, resource and feed, or the configuration error. */
  function utsConfig(env: UserBearerEnv): UtsConfig | { error: string } {
    const environment = utsEnvironmentOf(env.environment);
    if (environment === null) return { error: 'no_uts_environment' };
    const resourceOrigin = originOf(environment);
    if (resourceOrigin === null) return { error: 'no_resource_origin' };
    if (env.feed === undefined) return { error: 'no_feed_binding' };
    return { environment, resourceOrigin, feed: env.feed };
  }

  /**
   * The metadata URL `metadata()` serves for this deployment, or null while it answers 404. It
   * reads configuration only: it builds no verifier and calls no feed.
   */
  function servedMetadataUrl(env: UserBearerEnv, acceptance: UserBearerAcceptance): string | null {
    if (!acceptance.uts) return null;
    const configured = utsConfig(env);
    return 'error' in configured ? null : `${configured.resourceOrigin}${RESOURCE_METADATA_PATH}`;
  }

  return {
    async decide(token, env, routeName, waitUntil, requestOrg) {
      const acceptance = userBearerAcceptance(env.mode);
      if (acceptance === null) return misconfigured('accept_mode');
      if (acceptance.legacy && !acceptance.uts) return { kind: 'legacy' };
      if (!acceptance.legacy && !acceptance.uts) return challenged('disabled', null);
      // The legacy path answers a missing bearer as it always has.
      if (token === null && acceptance.legacy) return { kind: 'legacy' };
      const family = token === null ? null : userBearerFamily(token);
      if (family !== null && !acceptance[family]) {
        return challenged(`${family}_not_accepted`, servedMetadataUrl(env, acceptance));
      }
      if (family === 'legacy') return { kind: 'legacy' };
      const configured = utsConfig(env);
      if ('error' in configured) return misconfigured(configured.error);
      if (token === null) {
        return {
          kind: 'refused',
          reason: 'no_bearer',
          response: new Response(null, {
            status: 401,
            headers: {
              ...NO_STORE,
              'www-authenticate': `Bearer resource_metadata="${configured.resourceOrigin}${RESOURCE_METADATA_PATH}"`,
            },
          }),
        };
      }
      return await verifyUts(token, configured, config.routes[routeName], waitUntil, requestOrg);
    },

    metadata(env) {
      const acceptance = userBearerAcceptance(env.mode);
      const configured = acceptance?.uts === true ? utsConfig(env) : null;
      if (configured === null || 'error' in configured) {
        return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
      }
      return Response.json(
        {
          resource: configured.resourceOrigin,
          authorization_servers: [UTS_ENDPOINTS[configured.environment].issuer],
          bearer_methods_supported: ['header'],
          scopes_supported: [
            ...new Set(Object.values<UtsUserRoute>(config.routes).map(route => route.scope)),
          ],
        },
        { headers: { 'cache-control': 'public, max-age=300' } }
      );
    },
  };
}
