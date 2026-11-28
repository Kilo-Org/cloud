import 'server-only';
import { STS_O11Y_API_METRICS_WRITE, type StsEnvironment } from '@kilocode/sts-contracts';
import {
  stsServiceTokenIfHeld,
  stsTokenFailure,
  type StsTokenFailure,
} from '@kilocode/web-shared/lib/sts-service-tokens';

/**
 * The STS side of `O11Y_API_METRICS_SENDER_AUTH=sts`. `api-metrics.server.ts` imports this module
 * only for an STS send, so a `legacy` deployment never loads it.
 */

export type ApiMetricsTokenRead =
  | { kind: 'token'; token: string }
  | { kind: 'not_held' }
  | { kind: 'failed'; failure: StsTokenFailure };

/** The `o11y:api-metrics.write` token if the process holds one; never waits for a mint. */
export async function apiMetricsToken(environment: StsEnvironment): Promise<ApiMetricsTokenRead> {
  try {
    const read = await stsServiceTokenIfHeld(environment, STS_O11Y_API_METRICS_WRITE);
    return read.kind === 'failed' ? { kind: 'failed', failure: stsTokenFailure(read.error) } : read;
  } catch (error) {
    return { kind: 'failed', failure: stsTokenFailure(error) };
  }
}
