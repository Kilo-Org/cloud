import 'server-only';
import { waitUntil } from '@vercel/functions';
import type { StsEnvironment } from '@kilocode/sts-contracts';
import {
  stsServiceToken,
  stsTokenFailure,
  type StsTokenFailure,
} from '@kilocode/web-shared/lib/sts-service-tokens';
import type { AutoRoutingSenderRoute } from './auto-routing-sender';
import { AUTO_ROUTING_SENDER_SCOPES } from './auto-routing-sender-scopes';

/**
 * The STS side of the AI Gateway's auto-routing switches set to `sts`
 * (`auto-routing-gateway-sender.ts`). That module imports this one only for an STS send, so a
 * `legacy` deployment never loads it.
 */

export type AutoRoutingTokenRead =
  | { kind: 'token'; token: string }
  | { kind: 'deadline' }
  | { kind: 'failed'; failure: StsTokenFailure };

/**
 * The route's token from the process's shared token client: a held one resolves from memory in
 * microtasks; otherwise the read joins the client's one mint for the scope and waits until
 * `signal` aborts. The token client hands its attempt to `waitUntil` only when its own read
 * settles, so a wait that ends early registers the same in-flight attempt here: a frozen instance
 * still finishes the mint, and a later request reads its token.
 */
export async function autoRoutingSenderToken(
  environment: StsEnvironment,
  route: AutoRoutingSenderRoute,
  signal?: AbortSignal
): Promise<AutoRoutingTokenRead> {
  let attempt: Promise<AutoRoutingTokenRead>;
  try {
    attempt = stsServiceToken(environment, AUTO_ROUTING_SENDER_SCOPES[route]).then(
      token => ({ kind: 'token', token }),
      (error: unknown) => ({ kind: 'failed', failure: stsTokenFailure(error) })
    );
  } catch (error) {
    return { kind: 'failed', failure: stsTokenFailure(error) };
  }
  if (signal === undefined) return attempt;
  const ended = Promise.withResolvers<'deadline'>();
  const onAbort = () => ended.resolve('deadline');
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    const outcome = await Promise.race([attempt, ended.promise]);
    if (outcome !== 'deadline') return outcome;
    // Still the client's one in-flight mint for the scope; keeping it alive serves the next request.
    waitUntil(attempt);
    return { kind: 'deadline' };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
