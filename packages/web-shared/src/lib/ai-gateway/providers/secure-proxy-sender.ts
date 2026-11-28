import type { StsEnvironment } from '@kilocode/sts-contracts';
import { z } from 'zod';
import { SECURE_PROXY_SENDER_AUTH } from '@kilocode/web-shared/lib/config.server';
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
 *   rather than ask for a token it cannot hold.
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

export type SecureProxySenderFailure =
  /** `SECURE_PROXY_SENDER_AUTH` holds a value other than `sts` or `legacy`. */
  | 'auth_misconfigured'
  /** `sts` outside the `ai-gateway` build, which alone can hold the forward scope. */
  | 'not_ai_gateway'
  /** This deployment has no STS environment (`stsEnvironmentOfDeployment` refused it). */
  | 'no_sts_environment'
  /** No token is held; the read that minted one runs on in the background. */
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
  KILO_STS_WORKLOAD?: string;
};

export type SecureProxyCredentialOptions = {
  /**
   * The custom LLM credential's stored proxy secret, read only in `legacy` mode: an `sts` send
   * never touches it.
   */
  legacySecret: () => string;
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
 * The `Authorization` value of one forward through the secure proxy. `sts` never waits for a mint:
 * a held token is a memory read, and with none held the caller refuses the forward so a retry can
 * use the token its background read is minting (`stsServiceTokenIfHeld`).
 */
export async function secureProxyCredential(
  options: SecureProxyCredentialOptions
): Promise<SecureProxyCredential> {
  const mode = secureProxySenderAuth(options.auth ?? SECURE_PROXY_SENDER_AUTH);
  if (mode === null) return unavailable('auth_misconfigured');
  if (mode === 'legacy') {
    return { kind: 'ready', mode, authorization: `Bearer ${options.legacySecret()}` };
  }
  const runtime = options.runtime ?? process.env;
  if (runtime.KILO_STS_WORKLOAD !== 'ai-gateway') return unavailable('not_ai_gateway');
  // Loaded only under `sts`, so a `legacy` deployment never evaluates the token client, the
  // secrets transport or the Vercel OIDC exchange.
  const { stsEnvironmentOfDeployment } =
    await import('@kilocode/web-shared/lib/sts-secret-transport');
  let environment: StsEnvironment;
  try {
    environment = stsEnvironmentOfDeployment(runtime);
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
