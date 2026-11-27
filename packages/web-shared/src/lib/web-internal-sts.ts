import 'server-only';
import type { ServiceTokenRequest } from '@kilocode/service-token-client';
import type { StsEnvironment } from '@kilocode/sts-contracts';
import { WEB_INTERNAL_SENDER_AUTH } from '@kilocode/web-shared/lib/config.server';
import type { StsTokenFailure } from '@kilocode/web-shared/lib/sts-service-tokens';

/**
 * The credential `apps/ai-gateway` presents to the web app's own `/api/internal/*` routes (design
 * 6.5: the shared internal API secret moves to STS service tokens, one scope per sender boundary).
 * These senders run only in the US region, where only `kilocode-ai-gateway` is deployed; the
 * Frankfurt `kilocode-app` writes and reads its primary directly.
 *
 * `WEB_INTERNAL_SENDER_AUTH`, the senders' switch and their rollback (decision D59), set per
 * Vercel project:
 * - absent, empty or `legacy`: the route's legacy `x-internal-api-key`, exactly as before this
 *   switch existed. The switch to `sts` is a later config change, once the receiver accepts both.
 * - `sts`: an STS service token minted from this deployment's own STS environment
 *   (`stsEnvironmentOfDeployment`) with its Vercel identity, in `Authorization: Bearer`. The
 *   internal secret is never read. Only the `ai-gateway` workload can hold these scopes, since
 *   STS refuses a token for the caller's own audience: a build without `KILO_STS_WORKLOAD=ai-gateway`
 *   (inlined by `apps/ai-gateway/next.config.mjs`) sends nothing rather than ask for one.
 * Any other value sends nothing.
 */

/** The US-region usage writes handed to the Frankfurt app: usage record and Enkrypt record. */
export const STS_WEB_USAGE_RECORD_REGION_HANDOFF = {
  audience: 'web',
  scope: 'web:usage.region-handoff.record',
} as const satisfies ServiceTokenRequest;

/** The US-region read of a Claude payer state from the Frankfurt app's primary. */
export const STS_WEB_CLAUDE_BILLING_PAYER_STATE_READ = {
  audience: 'web',
  scope: 'web:claude-billing.payer-state.read',
} as const satisfies ServiceTokenRequest;

/**
 * The longest a region handoff waits for a cold mint. The handoffs count it inside their own
 * request budget and write locally without a token, so a slow STS cannot push the `after()` work
 * of an ai-gateway function (`maxDuration` 800 s) past its limit and lose the billing record.
 */
export const REGION_HANDOFF_TOKEN_WAIT_MS = 5_000;

export type WebInternalSenderMode = 'sts' | 'legacy';

export function webInternalSenderMode(value: string | undefined): WebInternalSenderMode | null {
  if (value === undefined || value === '' || value === 'legacy') return 'legacy';
  return value === 'sts' ? 'sts' : null;
}

export type WebInternalSenderFailure =
  /** `WEB_INTERNAL_SENDER_AUTH` holds a value other than `sts` or `legacy`. */
  | 'auth_misconfigured'
  /** `sts` outside the `ai-gateway` build: `kilocode-app` is the audience itself. */
  | 'not_ai_gateway'
  /** This deployment has no STS environment (`stsEnvironmentOfDeployment` refused it). */
  | 'no_sts_environment'
  /** STS or the Vercel identity gave no token, or none within the caller's `tokenWait`. */
  | 'token_unavailable'
  /** `tokenWait: 'held'` found no held token; the mint it started serves a later request. */
  | 'token_not_held'
  /** `legacy` mode with an empty internal secret. */
  | 'secret_missing';

export type WebInternalSenderCredential =
  | { kind: 'ready'; header: string; value: string }
  | { kind: 'unavailable'; reason: WebInternalSenderFailure };

export type WebInternalSenderOptions = {
  /** Read only in `legacy` mode; a rejection propagates, as the secret read did before. */
  legacySecret: () => Promise<string>;
  /** The switch value; `WEB_INTERNAL_SENDER_AUTH` by default. */
  auth?: string;
  /**
   * How long a read without a held token may wait under `sts`. `'held'` never waits: it answers
   * at once and the mint it starts runs on under `waitUntil` for a later request. A number waits
   * at most that many milliseconds for one mint; the caller counts it inside its own deadline.
   */
  tokenWait: 'held' | number;
};

/**
 * The header of one request to a web `/api/internal/*` route. A held token is a memory read; a
 * cold one waits for one mint for at most `tokenWait`. Renewals and abandoned mints run on under
 * the invocation's `waitUntil` (`sts-service-tokens.ts`).
 */
export async function webInternalSenderCredential(
  target: ServiceTokenRequest,
  options: WebInternalSenderOptions
): Promise<WebInternalSenderCredential> {
  const mode = webInternalSenderMode('auth' in options ? options.auth : WEB_INTERNAL_SENDER_AUTH);
  if (mode === null) return unavailable(target, 'auth_misconfigured');
  if (mode === 'legacy') {
    const secret = await options.legacySecret();
    return secret
      ? { kind: 'ready', header: 'x-internal-api-key', value: secret }
      : unavailable(target, 'secret_missing');
  }
  if (process.env.KILO_STS_WORKLOAD !== 'ai-gateway') return unavailable(target, 'not_ai_gateway');
  // Loaded only under `sts`, so a `legacy` deployment never evaluates the token client, the
  // secrets transport or the Vercel OIDC exchange.
  const { stsEnvironmentOfDeployment } =
    await import('@kilocode/web-shared/lib/sts-secret-transport');
  let environment: StsEnvironment;
  try {
    environment = stsEnvironmentOfDeployment(process.env);
  } catch {
    return unavailable(target, 'no_sts_environment');
  }
  const { stsServiceToken, stsServiceTokenIfHeld, stsTokenFailure } =
    await import('@kilocode/web-shared/lib/sts-service-tokens');
  const { tokenWait } = options;
  if (tokenWait === 'held') {
    const read = await stsServiceTokenIfHeld(environment, target);
    if (read.kind === 'token') {
      return { kind: 'ready', header: 'authorization', value: `Bearer ${read.token}` };
    }
    return read.kind === 'not_held'
      ? unavailable(target, 'token_not_held')
      : unavailable(target, 'token_unavailable', { failure: stsTokenFailure(read.error) });
  }
  const expired = Promise.withResolvers<null>();
  const timer = setTimeout(() => expired.resolve(null), tokenWait);
  try {
    const token = await Promise.race([stsServiceToken(environment, target), expired.promise]);
    return token === null
      ? unavailable(target, 'token_unavailable', { failure: { errorName: 'TimeoutError' } })
      : { kind: 'ready', header: 'authorization', value: `Bearer ${token}` };
  } catch (error) {
    return unavailable(target, 'token_unavailable', { failure: stsTokenFailure(error) });
  } finally {
    clearTimeout(timer);
  }
}

function unavailable(
  target: ServiceTokenRequest,
  reason: WebInternalSenderFailure,
  detail: { failure?: StsTokenFailure } = {}
): WebInternalSenderCredential {
  // One line per failed credential, so a mint-failure monitor can count them by scope. Never the
  // token, the secret or an error message.
  console.warn('[web-internal-sts] no credential for a web internal route', {
    audience: target.audience,
    scope: target.scope,
    reason,
    ...detail,
  });
  return { kind: 'unavailable', reason };
}
