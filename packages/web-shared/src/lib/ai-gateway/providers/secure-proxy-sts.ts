import 'server-only';
import { STS_SECURE_PROXY_FORWARD, type StsEnvironment } from '@kilocode/sts-contracts';
import {
  stsServiceToken,
  stsTokenFailure,
  type StsTokenFailure,
} from '@kilocode/web-shared/lib/sts-service-tokens';

/**
 * The STS side of `SECURE_PROXY_SENDER_AUTH=sts`. `secure-proxy-sender.ts` imports this module only
 * for an STS send, so a `legacy` deployment never loads it.
 */

/**
 * How long a cold instance waits for its first forward token. A fresh Vercel instance holds none,
 * and instances start all day, so without a wait the first proxied call of every instance would
 * answer 503 and a release's 5xx check would trip. The wait counts inside the request's upstream
 * duration budget (`UPSTREAM_DURATION_BUDGET_MS` in `upstream-request.ts`), which also covers the
 * provider call. A mint slower than this is rare: the read continues on `waitUntil` and the retry
 * uses its token.
 */
export const SECURE_PROXY_COLD_TOKEN_WAIT_MS = 2000;

export type SecureProxyTokenRead =
  | { kind: 'token'; token: string }
  | { kind: 'not_held' }
  | { kind: 'failed'; failure: StsTokenFailure };

type TokenAttempt = { kind: 'token'; token: string } | { kind: 'failed'; error: unknown };

/**
 * The `ai-gateway-secure-proxy:request.forward` token. A held one resolves from memory in
 * microtasks, so a warm instance never waits; a cold instance waits at most
 * `SECURE_PROXY_COLD_TOKEN_WAIT_MS` for one mint, which `stsServiceToken` hands to `waitUntil` so
 * it keeps running after the wait gives up.
 */
export async function secureProxyToken(environment: StsEnvironment): Promise<SecureProxyTokenRead> {
  try {
    const attempt: Promise<TokenAttempt> = stsServiceToken(
      environment,
      STS_SECURE_PROXY_FORWARD
    ).then(
      token => ({ kind: 'token', token }),
      (error: unknown) => ({ kind: 'failed', error })
    );
    const later = Promise.withResolvers<null>();
    const timer = setTimeout(() => later.resolve(null), SECURE_PROXY_COLD_TOKEN_WAIT_MS);
    let now: TokenAttempt | null;
    try {
      now = await Promise.race([attempt, later.promise]);
    } finally {
      clearTimeout(timer);
    }
    if (now === null) return { kind: 'not_held' };
    return now.kind === 'failed' ? { kind: 'failed', failure: stsTokenFailure(now.error) } : now;
  } catch (error) {
    return { kind: 'failed', failure: stsTokenFailure(error) };
  }
}
