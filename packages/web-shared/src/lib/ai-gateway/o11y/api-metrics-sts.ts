import 'server-only';
import { ServiceTokenError } from '@kilocode/service-token-client';
import { STS_O11Y_API_METRICS_WRITE, type StsEnvironment } from '@kilocode/sts-contracts';
import { stsServiceTokenIfHeld } from '@kilocode/web-shared/lib/sts-service-tokens';

/**
 * The STS side of `O11Y_API_METRICS_SENDER_AUTH=sts`. `api-metrics.server.ts` imports this module
 * only for an STS send, so a `legacy` deployment never loads it.
 */

/** Why there was no token: the error's name and the token client's closed reasons, never a message. */
export type ApiMetricsTokenFailure = {
  errorName: string;
  reason?: ServiceTokenError['reason'];
  deniedReason?: ServiceTokenError['deniedReason'];
};

export type ApiMetricsTokenRead =
  | { kind: 'token'; token: string }
  | { kind: 'not_held' }
  | { kind: 'failed'; failure: ApiMetricsTokenFailure };

function failure(error: unknown): ApiMetricsTokenFailure {
  if (error instanceof ServiceTokenError) {
    return error.deniedReason === undefined
      ? { errorName: error.name, reason: error.reason }
      : { errorName: error.name, reason: error.reason, deniedReason: error.deniedReason };
  }
  return { errorName: error instanceof Error ? error.name : typeof error };
}

/** The `o11y:api-metrics.write` token if the process holds one; never waits for a mint. */
export async function apiMetricsToken(environment: StsEnvironment): Promise<ApiMetricsTokenRead> {
  try {
    const read = await stsServiceTokenIfHeld(environment, STS_O11Y_API_METRICS_WRITE);
    return read.kind === 'failed' ? { kind: 'failed', failure: failure(read.error) } : read;
  } catch (error) {
    return { kind: 'failed', failure: failure(error) };
  }
}
