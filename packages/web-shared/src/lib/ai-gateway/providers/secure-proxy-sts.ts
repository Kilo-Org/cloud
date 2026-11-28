import 'server-only';
import { waitUntil } from '@vercel/functions';
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
 * `SECURE_PROXY_COLD_TOKEN_WAIT_MS` for one mint, or less when `signal` aborts (the client went
 * away or the request's budget ran out). The token client hands its attempt to `waitUntil` only
 * when its own read settles, up to its attempt timeout later, so a wait that ends early registers
 * the same in-flight attempt here: a frozen instance then still finishes the mint, and the retry
 * reads its token.
 */
export async function secureProxyToken(
  environment: StsEnvironment,
  options: { signal?: AbortSignal } = {}
): Promise<SecureProxyTokenRead> {
  const { signal } = options;
  try {
    // One read of the client's shared attempt: a concurrent cold call joins the same mint, and this
    // never starts a second one.
    const attempt: Promise<TokenAttempt> = stsServiceToken(
      environment,
      STS_SECURE_PROXY_FORWARD
    ).then(
      token => ({ kind: 'token', token }),
      (error: unknown) => ({ kind: 'failed', error })
    );
    const timedOut = Promise.withResolvers<'timeout'>();
    const timer = setTimeout(() => timedOut.resolve('timeout'), SECURE_PROXY_COLD_TOKEN_WAIT_MS);
    const aborted = Promise.withResolvers<'aborted'>();
    const onAbort = () => aborted.resolve('aborted');
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    let outcome: TokenAttempt | 'timeout' | 'aborted';
    try {
      outcome = await Promise.race([attempt, timedOut.promise, aborted.promise]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (outcome === 'timeout' || outcome === 'aborted') {
      // The attempt is still the client's one in-flight mint. Keeping it alive is what makes the
      // retry succeed instead of the instance freezing mid-mint.
      waitUntil(attempt);
      return { kind: 'not_held' };
    }
    return outcome.kind === 'failed'
      ? { kind: 'failed', failure: stsTokenFailure(outcome.error) }
      : outcome;
  } catch (error) {
    return { kind: 'failed', failure: stsTokenFailure(error) };
  }
}
