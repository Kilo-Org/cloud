import 'server-only';
import { STS_O11Y_API_METRICS_WRITE, type StsEnvironment } from '@kilocode/sts-contracts';
import { stsServiceToken } from '@kilocode/web-shared/lib/sts-service-tokens';

/**
 * The STS side of `O11Y_API_METRICS_SENDER_AUTH=sts`. `api-metrics.server.ts` imports this module
 * only for an STS send, so a `legacy` deployment never loads it.
 */
export function apiMetricsToken(environment: StsEnvironment): Promise<string> {
  return stsServiceToken(environment, STS_O11Y_API_METRICS_WRITE);
}
