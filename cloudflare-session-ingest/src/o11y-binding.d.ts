/**
 * Augment the wrangler-generated Env to give the O11Y service binding its RPC
 * method types.  `wrangler types` only sees `Fetcher` for service bindings;
 * the actual RPC shape comes from the o11y worker's WorkerEntrypoint and is
 * declared here so the generated file can be freely regenerated.
 */

import type { SessionMetricsParamsInput } from '@kilocode/worker-utils';

export type O11YBinding = Fetcher & {
  ingestSessionMetrics(params: SessionMetricsParamsInput): Promise<void>;
};
