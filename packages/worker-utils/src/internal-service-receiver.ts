import { STS_ISSUERS, StsEnvironmentSchema, type StsEnvironment } from '@kilocode/sts-contracts';
import { createVerifier, failureResponse, httpJwksSource, type Verifier } from '@kilocode/verify';
import { observeInternalAuth, type InternalAuthSink } from './internal-auth-observation';

/**
 * The receiving side of a web -> Worker internal route (design 6.5, decision D59): the shared
 * internal API secret moves to an STS service token, one route at a time, behind the receiver's
 * own switch `INTERNAL_CREDENTIAL_ACCEPT`. The values and their meaning are o11y's
 * (`services/o11y/src/admin-middleware.ts`):
 * - absent, empty or `legacy-only`: the Worker's own legacy check, exactly as before. No verifier
 *   is built, no key set is fetched and no new header is read;
 * - `legacy-and-sts`: a request with `Authorization` must carry a valid STS token; one without it
 *   runs the legacy check;
 * - `sts-only`: only an STS token; the legacy secret is never read;
 * - `disabled`: every request is refused.
 * Any other value refuses every request with 500, never a default. A request that carries both the
 * legacy header and `Authorization` is refused in the STS modes, and a refused STS token is never
 * retried as legacy. Rollback is a redeploy with the value set back to `legacy-only`.
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

/** The credentials `mode` admits, or null when the value is outside the closed set. */
export function internalCredentialAcceptance(mode: string | undefined): Acceptance | null {
  if (mode === undefined || mode === '') return ACCEPTANCE['legacy-only'];
  return Object.hasOwn(ACCEPTANCE, mode) ? ACCEPTANCE[mode as InternalCredentialAcceptMode] : null;
}

/** RFC 9728 protected-resource metadata path; every STS 401 challenge names it. */
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/**
 * The receiver's deployment settings, read only from the Worker's own configuration:
 * - `INTERNAL_CREDENTIAL_ACCEPT` (default `legacy-only`);
 * - `STS_ENVIRONMENT`, the one `env` claim and issuer STS tokens must carry;
 * - `STS_RESOURCE_ORIGIN`, this Worker's canonical origin: the RFC 9728 `resource` and the base of
 *   the challenge's metadata URL. Exactly an `https:` origin, or a loopback `http:` origin in
 *   `development`. Never the request's Host.
 * The two STS settings are read only in an STS mode; missing or invalid, an STS request gets 500.
 */
export type InternalReceiverEnv = {
  INTERNAL_CREDENTIAL_ACCEPT?: string;
  STS_ENVIRONMENT?: string;
  STS_RESOURCE_ORIGIN?: string;
};

/** One route family's contract: its STS scope, the workloads that may call it, its label. */
export type InternalRouteContract = {
  /** The observation label of the route family, as the legacy counter already writes it. */
  label: string;
  scope: string;
  /** STS policy grants the scope only to these workloads; the receiver repeats the check. */
  workloads: readonly string[];
  /** The header the legacy check reads, so a request carrying both is refused. */
  legacyHeader: string;
};

export type InternalServiceReceiverConfig = {
  /** The counter's receiver label, such as `notifications`. */
  receiver: string;
  /** The STS audience of this Worker; every route's scope belongs to it. */
  audience: string;
  /** Every route family of this Worker, for the metadata document. */
  routes: readonly InternalRouteContract[];
};

/** Runs the Worker's legacy check, unchanged: null admits, a response refuses. */
export type LegacyCheck = () => Promise<Response | null>;

export type AdmitOptions = {
  waitUntil: (promise: Promise<unknown>) => void;
  /** A Worker without Logpush passes its Analytics Engine sink, as its legacy counter does. */
  sink?: InternalAuthSink;
};

const NO_STORE = { 'cache-control': 'no-store' };

type StsRouteConfig = { environment: StsEnvironment; origin: string };

const LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
  localhost: true,
  '127.0.0.1': true,
  '[::1]': true,
};

function stsRouteConfig(env: InternalReceiverEnv): StsRouteConfig | { error: string } {
  const environment = StsEnvironmentSchema.safeParse(env.STS_ENVIRONMENT);
  if (!environment.success) return { error: 'sts_environment' };
  const configured = env.STS_RESOURCE_ORIGIN;
  if (configured === undefined) return { error: 'resource_origin' };
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return { error: 'resource_origin' };
  }
  const allowed =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' &&
      environment.data === 'development' &&
      Object.hasOwn(LOOPBACK_HOSTS, url.hostname));
  if (!allowed || url.origin !== configured) return { error: 'resource_origin' };
  return { environment: environment.data, origin: configured };
}

export type InternalServiceReceiver = {
  /**
   * Admits one request to `route`: null admits it, a response refuses it. Reads only the
   * request's headers, never its body.
   */
  admit: (
    request: Request,
    env: InternalReceiverEnv,
    route: InternalRouteContract,
    legacy: LegacyCheck,
    options: AdmitOptions
  ) => Promise<Response | null>;
  /**
   * `GET /.well-known/oauth-protected-resource`: the metadata the STS challenge names, only while
   * the receiver admits STS and its STS settings are valid; otherwise null (the Worker's 404).
   */
  protectedResourceMetadata: (env: InternalReceiverEnv) => Response | null;
};

/**
 * The receiver of one Worker. Create it at module scope: it holds one STS verifier per
 * environment and origin, built on the first STS request, so its key set serves every later
 * request of the isolate.
 */
export function createInternalServiceReceiver(
  config: InternalServiceReceiverConfig
): InternalServiceReceiver {
  const verifiers = new Map<string, Verifier<false>>();

  function misconfigured(reason: string): Response {
    console.error(
      JSON.stringify({
        event: 'internal_receiver_misconfigured',
        receiver: config.receiver,
        reason,
      })
    );
    return Response.json({ error: 'server_misconfigured' }, { status: 500, headers: NO_STORE });
  }

  function refused(route: InternalRouteContract, status: number, reason: string): void {
    // Never the credential: the route family, the status and the rule only.
    console.warn(
      JSON.stringify({
        event: 'internal_receiver_sts_refused',
        receiver: config.receiver,
        route: route.label,
        status,
        reason,
      })
    );
  }

  function verifierFor({ environment, origin }: StsRouteConfig): Verifier<false> {
    const key = `${environment}|${origin}`;
    const held = verifiers.get(key);
    if (held !== undefined) return held;
    const issuer = STS_ISSUERS[environment];
    // The key set comes from the issuer's own origin: STS exposes only `SecretsBroker` to other
    // Workers over a binding, which serves no key set.
    const verifier = createVerifier({
      audience: config.audience,
      environment,
      resourceMetadataUrl: `${origin}${RESOURCE_METADATA_PATH}`,
      // The registry is the default `STS_SCOPE_REGISTRY`, where every receiver scope lives.
      sts: { issuer, jwks: httpJwksSource(issuer) },
    });
    verifiers.set(key, verifier);
    return verifier;
  }

  async function stsCheck(
    request: Request,
    route: InternalRouteContract,
    sts: StsRouteConfig,
    options: AdmitOptions
  ): Promise<Response | null> {
    const metadata = `resource_metadata="${sts.origin}${RESOURCE_METADATA_PATH}"`;
    if (request.headers.has('authorization') && request.headers.has(route.legacyHeader)) {
      // Two credentials: answer neither, so no request is decided by the weaker one.
      refused(route, 400, 'mixed_credentials');
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
    const result = await verifierFor(sts).verify(
      request.headers.get('authorization'),
      { issuer: 'sts', scope: route.scope },
      { waitUntil: options.waitUntil }
    );
    if (!result.ok) {
      refused(route, result.status, result.reason);
      return failureResponse(result);
    }
    const workload = result.caller.kind === 'service' ? result.caller.workload : null;
    if (workload === null || !route.workloads.includes(workload)) {
      refused(route, 403, 'workload_not_allowed');
      return Response.json(
        { error: 'insufficient_scope', scope: route.scope },
        {
          status: 403,
          headers: {
            ...NO_STORE,
            'www-authenticate': `Bearer error="insufficient_scope", scope="${route.scope}", ${metadata}`,
          },
        }
      );
    }
    observeInternalAuth(config.receiver, route.label, 'sts', workload, options.sink);
    return null;
  }

  return {
    async admit(request, env, route, legacy, options) {
      const acceptance = internalCredentialAcceptance(env.INTERNAL_CREDENTIAL_ACCEPT);
      if (acceptance === null) return misconfigured('accept_mode');
      // The default: exactly the legacy path. No verifier, key set or new header read.
      if (acceptance.legacy && !acceptance.sts) return legacy();
      if (!acceptance.legacy && !acceptance.sts) {
        return Response.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
      }
      // An STS bearer arrives only in `Authorization`, the shared secret only in its own header.
      if (acceptance.legacy && !request.headers.has('authorization')) return legacy();
      const sts = stsRouteConfig(env);
      if ('error' in sts) return misconfigured(sts.error);
      return stsCheck(request, route, sts, options);
    },

    protectedResourceMetadata(env) {
      if (internalCredentialAcceptance(env.INTERNAL_CREDENTIAL_ACCEPT)?.sts !== true) return null;
      const sts = stsRouteConfig(env);
      if ('error' in sts) return null;
      return Response.json(
        {
          resource: sts.origin,
          authorization_servers: [STS_ISSUERS[sts.environment]],
          bearer_methods_supported: ['header'],
          scopes_supported: [...new Set(config.routes.map(route => route.scope))],
        },
        { headers: { 'cache-control': 'public, max-age=300' } }
      );
    },
  };
}
