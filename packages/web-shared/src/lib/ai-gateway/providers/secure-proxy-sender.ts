import type { StsEnvironment } from '@kilocode/sts-contracts';
import { z } from 'zod';
import {
  SECURE_PROXY_EXPECTED_ORIGIN,
  SECURE_PROXY_SENDER_AUTH,
} from '@kilocode/web-shared/lib/config.server';
import type { StsTokenFailure } from '@kilocode/web-shared/lib/sts-service-tokens';

/**
 * The credential the AI Gateway presents to `apps/ai-gateway-secure-proxy` (design 6.5: the shared
 * proxy bearer moves to an STS service token for the one forward scope).
 *
 * `SECURE_PROXY_SENDER_AUTH`, the sender's switch and its rollback (decision D59), set on the
 * `kilocode-ai-gateway` project:
 * - absent, empty or `legacy`: `Authorization: Bearer <proxy_secret>` of the custom LLM credential,
 *   exactly as before this switch existed. The switch to `sts` is a later config change, once the
 *   proxy accepts STS and STS grants the scope.
 * - `sts`: only an `ai-gateway-secure-proxy:request.forward` STS service token in
 *   `Authorization: Bearer`, minted from this deployment's own STS environment with its Vercel
 *   identity. The stored proxy secret is never read, and a missing token never falls back to it.
 *   The proxy verifies against its own deployment's STS issuer, so a token of another environment
 *   is refused there. STS grants the scope only to the `ai-gateway` workload, so a build without
 *   `KILO_STS_WORKLOAD=ai-gateway` (inlined by `apps/ai-gateway/next.config.mjs`) sends nothing
 *   rather than ask for a token it cannot hold. The destination is pinned: the forward is refused
 *   before any token read unless the proxy URL's origin is exactly `SECURE_PROXY_EXPECTED_ORIGIN`,
 *   so a misconfigured custom LLM credential cannot make the gateway hand its token elsewhere.
 * Any other value sends nothing.
 *
 * This module imports no STS transport, so a `legacy` deployment never loads the token client or
 * the Vercel OIDC exchange; `secure-proxy-sts.ts` holds them and is imported only for an STS send.
 */
export type SecureProxySenderMode = 'legacy' | 'sts';

export const SecureProxySenderAuthSchema = z.preprocess(
  value => (value === '' ? undefined : value),
  z.enum(['legacy', 'sts']).default('legacy')
);

/** The switch's mode, or null when the value is outside the closed set: nothing is sent. */
export function secureProxySenderAuth(value: unknown): SecureProxySenderMode | null {
  const parsed = SecureProxySenderAuthSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * `SECURE_PROXY_EXPECTED_ORIGIN`: exactly an `https:` origin, no path, query, fragment or
 * credentials. The same value as the proxy's own `KILO_AI_GATEWAY_SECURE_PROXY_ORIGIN`.
 */
const ExpectedOriginSchema = z.string().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
});

/** The configured `https:` origin, or null when unset or invalid: no token is ever sent. */
function expectedProxyOrigin(value: string | undefined): string | null {
  const parsed = ExpectedOriginSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** `url`'s origin, or null when it is not a URL: then it can satisfy no expected origin. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export type SecureProxySenderFailure =
  /** `SECURE_PROXY_SENDER_AUTH` holds a value other than `sts` or `legacy`. */
  | 'auth_misconfigured'
  /** `sts` outside the `ai-gateway` build, which alone can hold the forward scope. */
  | 'not_ai_gateway'
  /** The proxy URL's origin is not `SECURE_PROXY_EXPECTED_ORIGIN`, or that is unset. */
  | 'proxy_origin_mismatch'
  /** This deployment has no STS environment (`stsEnvironmentOfDeployment` refused it). */
  | 'no_sts_environment'
  /** No token arrived within the cold-instance wait; the read that minted one runs on. */
  | 'credential_not_held'
  /** STS refused a token; a policy, identity or registry change fixes it, waiting does not. */
  | 'token_denied'
  /** STS gave no token in time, or the transport failed; a later request may succeed. */
  | 'token_unavailable';

export type SecureProxyCredential =
  /** `authorization` is the complete `Authorization` header value. */
  | { kind: 'ready'; mode: SecureProxySenderMode; authorization: string }
  | { kind: 'unavailable'; reason: SecureProxySenderFailure };

/** The deployment's runtime variables; `process.env` itself in production. */
export type SecureProxyRuntime = Readonly<Record<string, string | undefined>> & {
  VERCEL_ENV?: string;
  VERCEL_TARGET_ENV?: string;
};

export type SecureProxyCredentialOptions = {
  /**
   * The custom LLM credential's stored proxy secret, read only in `legacy` mode: an `sts` send
   * never touches it.
   */
  legacySecret: () => string;
  /** The exact proxy destination (`provider.secureProxy.url`); pinned under `sts`. */
  proxyUrl: string;
  /** The switch value; `SECURE_PROXY_SENDER_AUTH` by default. */
  auth?: string;
  /** The deployment's runtime variables; `process.env` by default. */
  runtime?: SecureProxyRuntime;
};

/** Reported once per reason and process: this runs on the LLM request path. */
const reported = new Set<SecureProxySenderFailure>();

function unavailable(
  reason: SecureProxySenderFailure,
  detail: { failure?: StsTokenFailure } = {}
): SecureProxyCredential {
  if (!reported.has(reason)) {
    reported.add(reason);
    // Only the reason; never the token, the secret or an error message.
    console.warn('[secure-proxy-sender] no credential for the secure proxy forward', {
      reason,
      ...detail,
    });
  }
  return { kind: 'unavailable', reason };
}

/**
 * The `Authorization` value of one forward through the secure proxy. `sts` reads a held token
 * without waiting, and a cold instance waits at most the mint bound
 * (`SECURE_PROXY_COLD_TOKEN_WAIT_MS` in `secure-proxy-sts.ts`): with no token by then the caller
 * refuses the forward so the retry uses the token that read is minting. No mint runs unbounded on
 * the request path.
 */
export async function secureProxyCredential(
  options: SecureProxyCredentialOptions
): Promise<SecureProxyCredential> {
  const mode = secureProxySenderAuth(options.auth ?? SECURE_PROXY_SENDER_AUTH);
  if (mode === null) return unavailable('auth_misconfigured');
  if (mode === 'legacy') {
    return { kind: 'ready', mode, authorization: `Bearer ${options.legacySecret()}` };
  }
  const destination = expectedProxyOrigin(SECURE_PROXY_EXPECTED_ORIGIN);
  if (destination === null || originOf(options.proxyUrl) !== destination) {
    return unavailable('proxy_origin_mismatch');
  }
  // Literal `process.env` access, so Next inlines the value `apps/ai-gateway/next.config.mjs`
  // sets at build time (`web-internal-sts.ts` does the same).
  if (process.env.KILO_STS_WORKLOAD !== 'ai-gateway') return unavailable('not_ai_gateway');
  // Loaded only under `sts`, so a `legacy` deployment never evaluates the token client, the
  // secrets transport or the Vercel OIDC exchange.
  const { stsEnvironmentOfDeployment } =
    await import('@kilocode/web-shared/lib/sts-secret-transport');
  let environment: StsEnvironment;
  try {
    environment = stsEnvironmentOfDeployment(options.runtime ?? process.env);
  } catch {
    return unavailable('no_sts_environment');
  }
  const { secureProxyToken } = await import('./secure-proxy-sts');
  const read = await secureProxyToken(environment);
  switch (read.kind) {
    case 'token':
      return { kind: 'ready', mode, authorization: `Bearer ${read.token}` };
    case 'not_held':
      return unavailable('credential_not_held');
    case 'failed':
      return unavailable(read.failure.reason === 'denied' ? 'token_denied' : 'token_unavailable', {
        failure: read.failure,
      });
  }
}
