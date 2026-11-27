import {
  createWorkerServiceTokens,
  ServiceTokenError,
  type MintBinding,
  type ServiceTokenRequest,
  type ServiceTokens,
} from '@kilocode/service-token-client';

/**
 * The credential a Worker presents to one of the web app's `/api/internal/*` routes (design 6.5:
 * the shared internal API secret moves to STS service tokens, one scope per sender boundary).
 *
 * `WEB_INTERNAL_AUTH` is the sender's switch and its rollback (decision D59):
 * - absent, empty or `sts`: an STS service token for the route's scope, minted over the Worker's
 *   `STS` binding and sent as `Authorization: Bearer`. The legacy secret is never read.
 * - `legacy`: the route's legacy shared-secret header, exactly as before this switch existed.
 * Any other value sends nothing.
 */
export type WebInternalAuthMode = 'sts' | 'legacy';

export type WebInternalAuthEnv = {
  WEB_INTERNAL_AUTH?: string;
  /** `{ binding: "STS", service: "sts", entrypoint: "SecretsBroker", props: { caller } }`. */
  STS?: MintBinding;
};

export function webInternalAuthMode(value: string | undefined): WebInternalAuthMode | null {
  if (value === undefined || value === '' || value === 'sts') return 'sts';
  return value === 'legacy' ? 'legacy' : null;
}

/**
 * The scopes Workers present to the web app, audience `web`. Each names one sender boundary; the
 * receiving route accepts it only from the workload STS grants it to.
 */
export const STS_WEB_COMPUTE_BALANCE_ALERT = {
  audience: 'web',
  scope: 'web:compute-balance-alert.send',
} as const satisfies ServiceTokenRequest;
export const STS_WEB_SCIM_SYNC = {
  audience: 'web',
  scope: 'web:scim.sync',
} as const satisfies ServiceTokenRequest;
export const STS_WEB_USER_DATA_EXPORT_READY = {
  audience: 'web',
  scope: 'web:user-data-exports.ready',
} as const satisfies ServiceTokenRequest;
export const STS_WEB_AUTO_ROUTING_POOL_PINS_WRITE = {
  audience: 'web',
  scope: 'web:auto-routing.pool-pins.write',
} as const satisfies ServiceTokenRequest;
export const STS_WEB_USAGE_RECEIPTS_READ = {
  audience: 'web',
  scope: 'web:usage.receipts.read',
} as const satisfies ServiceTokenRequest;
export const STS_WEB_AUTO_ROUTING_PRODUCTION_PROFILE_READ = {
  audience: 'web',
  scope: 'web:auto-routing.production-profile.read',
} as const satisfies ServiceTokenRequest;

export type WebInternalCredentialFailure =
  /** `WEB_INTERNAL_AUTH` holds a value other than `sts` or `legacy`. */
  | 'auth_misconfigured'
  /** `sts` mode on a Worker deployed without the `STS` binding. */
  | 'sts_binding_missing'
  /** STS refused the token; a policy, identity or registry change fixes it, waiting does not. */
  | 'token_denied'
  /** STS gave no token in time; a later attempt may succeed. */
  | 'token_unavailable'
  /** `legacy` mode with an empty secret. */
  | 'secret_missing';

export type WebInternalCredential =
  | { kind: 'ready'; header: string; value: string }
  | { kind: 'unavailable'; reason: WebInternalCredentialFailure };

export type LegacyWebInternalCredential = {
  /** The header the route's legacy check reads: `x-internal-api-key`, `X-Internal-Secret`, … */
  header: string;
  /** Read only in `legacy` mode. A rejection propagates, as the secret read did before. */
  secret: () => Promise<string | null | undefined>;
  /** Formats the header value; the identity by default. */
  format?: (secret: string) => string;
};

/** One token client per isolate, keyed by the binding object. */
let tokens: { binding: MintBinding; client: ServiceTokens } | null = null;

function tokensFor(binding: MintBinding): ServiceTokens {
  if (tokens?.binding !== binding) tokens = { binding, client: createWorkerServiceTokens(binding) };
  return tokens.client;
}

function unavailable(
  target: ServiceTokenRequest,
  reason: WebInternalCredentialFailure,
  detail: Record<string, string | number> = {}
): WebInternalCredential {
  // One line per failed credential, so a mint-failure monitor can count them by scope. The token,
  // the secret and the error message never appear.
  console.warn(
    JSON.stringify({
      event: 'web_internal_credential_unavailable',
      audience: target.audience,
      scope: target.scope,
      reason,
      ...detail,
    })
  );
  return { kind: 'unavailable', reason };
}

/**
 * The header for one request to a web `/api/internal/*` route. In `sts` mode a warm token is a
 * memory read; a cold one waits for one mint over the binding (at most the client's attempt
 * timeout). The callers are queue consumers, alarms and crons, not user requests, so the read
 * waits for a renewal it starts rather than handing it to `waitUntil`.
 */
export async function webInternalCredential(
  env: WebInternalAuthEnv,
  target: ServiceTokenRequest,
  legacy: LegacyWebInternalCredential
): Promise<WebInternalCredential> {
  const mode = webInternalAuthMode(env.WEB_INTERNAL_AUTH);
  if (mode === null) return unavailable(target, 'auth_misconfigured');
  if (mode === 'legacy') {
    const secret = await legacy.secret();
    if (!secret) return unavailable(target, 'secret_missing');
    return { kind: 'ready', header: legacy.header, value: legacy.format?.(secret) ?? secret };
  }
  if (env.STS === undefined) return unavailable(target, 'sts_binding_missing');
  try {
    const token = await tokensFor(env.STS).get(target);
    return { kind: 'ready', header: 'authorization', value: `Bearer ${token}` };
  } catch (error) {
    if (!(error instanceof ServiceTokenError)) {
      return unavailable(target, 'token_unavailable', {
        error_name: error instanceof Error ? error.name : typeof error,
      });
    }
    return error.reason === 'denied'
      ? unavailable(target, 'token_denied', { denied_reason: error.deniedReason ?? 'unknown' })
      : unavailable(target, 'token_unavailable', {
          retry_after_seconds: error.retryAfterSeconds ?? 0,
        });
  }
}
