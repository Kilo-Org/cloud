import {
  STS_ISSUERS,
  STS_SECURE_PROXY_FORWARD,
  type StsEnvironment,
} from '@kilocode/sts-contracts';
import {
  createVerifier,
  failureResponse,
  httpJwksSource,
  type Verifier,
  type WaitUntil,
} from '@kilocode/verify';

/**
 * Which credentials the proxy accepts (design 6.5: the shared
 * `KILO_AI_GATEWAY_SECURE_PROXY_SECRET` bearer moves to an STS service token). The set is closed:
 * any other value refuses every request with 500, never a default. Unset means `legacy-only`, the
 * behaviour before phase 4, which builds no verifier and fetches nothing. `sts-only` never reads
 * the shared secret. Rollback is a redeploy with the value set back, independent of the gateway's
 * own switch.
 */
export const CREDENTIAL_ACCEPT_ENV = 'KILO_AI_GATEWAY_SECURE_PROXY_CREDENTIAL_ACCEPT';

export type CredentialAcceptance = { legacy: boolean; sts: boolean };

const ACCEPTANCE = {
  disabled: { legacy: false, sts: false },
  'legacy-only': { legacy: true, sts: false },
  'legacy-and-sts': { legacy: true, sts: true },
  'sts-only': { legacy: false, sts: true },
} as const satisfies Record<string, CredentialAcceptance>;

type CredentialAcceptMode = keyof typeof ACCEPTANCE;

function isAcceptMode(value: string): value is CredentialAcceptMode {
  return Object.hasOwn(ACCEPTANCE, value);
}

/** The credentials `value` admits, or null when it is outside the closed set. */
export function credentialAcceptance(value: string | undefined): CredentialAcceptance | null {
  if (value === undefined || value === '') return ACCEPTANCE['legacy-only'];
  return isAcceptMode(value) ? ACCEPTANCE[value] : null;
}

/**
 * Set to `1` only for a local fixture, off Vercel: the proxy then verifies against the development
 * STS issuer (`STS_ISSUERS.development`, a loopback URL). On Vercel its presence refuses every
 * service token, so a deployment can never select the development issuer.
 */
export const LOCAL_STS_FIXTURE_ENV = 'KILO_AI_GATEWAY_SECURE_PROXY_LOCAL_STS_FIXTURE';

/**
 * This proxy's canonical origin, such as `https://proxy.example.com`: exactly an `https:` origin,
 * with no credentials, path, query or fragment. It names the RFC 9728 metadata in every challenge
 * and is that document's `resource`. Never the request's Host or the per-deployment `VERCEL_URL`.
 */
export const ORIGIN_ENV = 'KILO_AI_GATEWAY_SECURE_PROXY_ORIGIN';

type DeploymentEnv = Partial<
  Record<
    | 'VERCEL'
    | 'VERCEL_ENV'
    | 'VERCEL_TARGET_ENV'
    | typeof ORIGIN_ENV
    | typeof LOCAL_STS_FIXTURE_ENV,
    string
  >
>;

/** The STS environment this deployment verifies against, and its canonical origin. */
export type StsDeployment = { environment: StsEnvironment; origin: string };

/** The `next dev` origin of this app (`package.json`): the fixture's origin when none is set. */
const LOCAL_ORIGIN = 'http://localhost:3020';

/** The protected-resource metadata path (RFC 9728 section 3), served by its own route. */
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

/** `value` when it is exactly its own `https:` origin, so nothing but scheme, host and port. */
function canonicalOrigin(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === 'https:' && url.origin === value ? value : null;
}

/**
 * The repository's deployment predicate (`packages/web-shared/AGENTS.md`): production needs both
 * labels `production`; the staging custom environment is `VERCEL_TARGET_ENV=staging` without
 * `VERCEL_ENV=production`. A preview or any other target has no STS environment.
 */
function vercelEnvironment(env: DeploymentEnv): StsEnvironment | null {
  if (env.VERCEL_ENV === 'production' && env.VERCEL_TARGET_ENV === 'production') {
    return 'production';
  }
  if (env.VERCEL_TARGET_ENV === 'staging' && env.VERCEL_ENV !== 'production') return 'staging';
  return null;
}

/**
 * From the platform's own deployment labels and the configured origin, never from a request's
 * Host, URL or token. Null: no STS environment or no valid origin, so every service token is
 * refused with 500 and the metadata route answers 404.
 */
export function stsDeployment(): StsDeployment | null {
  const env: DeploymentEnv = {
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_TARGET_ENV: process.env.VERCEL_TARGET_ENV,
    [ORIGIN_ENV]: process.env[ORIGIN_ENV],
    [LOCAL_STS_FIXTURE_ENV]: process.env[LOCAL_STS_FIXTURE_ENV],
  };
  const onVercel =
    env.VERCEL !== undefined || env.VERCEL_ENV !== undefined || env.VERCEL_TARGET_ENV !== undefined;
  const configured = env[ORIGIN_ENV];
  const origin = configured === undefined ? null : canonicalOrigin(configured);
  if (env[LOCAL_STS_FIXTURE_ENV] !== undefined) {
    if (onVercel || env[LOCAL_STS_FIXTURE_ENV] !== '1') return null;
    if (configured === undefined) return { environment: 'development', origin: LOCAL_ORIGIN };
    return origin === null ? null : { environment: 'development', origin };
  }
  const environment = vercelEnvironment(env);
  return environment === null || origin === null ? null : { environment, origin };
}

/**
 * The RFC 9728 metadata of the relay, at `PROTECTED_RESOURCE_PATH` of the canonical origin: this
 * environment's STS issuer and the one forward scope. A plain 404 unless the mode admits STS
 * tokens and the deployment has an STS environment and a valid origin.
 */
export function protectedResourceMetadata(): Response {
  const acceptance = credentialAcceptance(process.env[CREDENTIAL_ACCEPT_ENV]);
  const deployment = stsDeployment();
  if (acceptance?.sts !== true || deployment === null) return new Response(null, { status: 404 });
  return Response.json(
    {
      resource: deployment.origin,
      authorization_servers: [STS_ISSUERS[deployment.environment]],
      scopes_supported: [STS_SECURE_PROXY_FORWARD.scope],
      bearer_methods_supported: ['header'],
    },
    { headers: NO_STORE }
  );
}

/**
 * The one sender (coordination: P2's Secure Proxy contract). STS grants `STS_SECURE_PROXY_FORWARD`
 * only to this workload; the proxy repeats the check, so a policy change alone never opens the
 * relay to another caller.
 */
export const SECURE_PROXY_SENDER = 'ai-gateway';

const NO_STORE = { 'cache-control': 'no-store' };

/** A configuration error: logged by its fixed reason only, never a configured value. */
export function misconfigured(reason: string): Response {
  console.error('[secure-proxy] Credential admission is misconfigured', { reason });
  return Response.json({ error: 'server_misconfigured' }, { status: 500, headers: NO_STORE });
}

/**
 * The STS check: a service token from this deployment's own STS issuer and environment, with the
 * audience and scope of `STS_SECURE_PROXY_FORWARD`, from `SECURE_PROXY_SENDER`. Resolves null when
 * it admits the request; otherwise the response, and that refusal is final. It reads only the
 * `Authorization` header, never the body. Create it at module scope: it holds one verifier per
 * environment, built on the first service token, so its key set serves every later request.
 */
export function createServiceTokenAdmission(
  waitUntil: WaitUntil
): (request: Request) => Promise<Response | null> {
  const verifiers = new Map<string, Verifier<false>>();

  function verifierFor({ environment, origin }: StsDeployment): Verifier<false> {
    const key = `${environment}|${origin}`;
    const held = verifiers.get(key);
    if (held !== undefined) return held;
    const issuer = STS_ISSUERS[environment];
    const verifier = createVerifier({
      audience: STS_SECURE_PROXY_FORWARD.audience,
      environment,
      resourceMetadataUrl: `${origin}${PROTECTED_RESOURCE_PATH}`,
      sts: { issuer, jwks: httpJwksSource(issuer) },
    });
    verifiers.set(key, verifier);
    return verifier;
  }

  return async request => {
    const deployment = stsDeployment();
    if (deployment === null) return misconfigured('no STS environment or origin');
    const { scope } = STS_SECURE_PROXY_FORWARD;
    const result = await verifierFor(deployment).verify(
      request,
      { issuer: 'sts', scope },
      { waitUntil }
    );
    if (!result.ok) {
      // The rule only; the credential never reaches a log.
      console.warn('[secure-proxy] Rejected service token', {
        status: result.status,
        reason: result.reason,
      });
      return failureResponse(result);
    }
    if (result.caller.kind !== 'service' || result.caller.workload !== SECURE_PROXY_SENDER) {
      console.warn('[secure-proxy] Rejected service token', { status: 403, reason: 'workload' });
      return Response.json(
        { error: 'insufficient_scope', scope },
        {
          status: 403,
          headers: {
            ...NO_STORE,
            'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${deployment.origin}${PROTECTED_RESOURCE_PATH}"`,
          },
        }
      );
    }
    return null;
  };
}
