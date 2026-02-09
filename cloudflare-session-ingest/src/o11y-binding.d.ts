/**
 * Augment the wrangler-generated Env to give the O11Y service binding its RPC
 * method types.  `wrangler types` only sees `Fetcher` for service bindings;
 * the actual RPC shape comes from the o11y worker's WorkerEntrypoint and is
 * declared here so the generated file can be freely regenerated.
 *
 * Keep in sync with: cloudflare-o11y/src/session-metrics-schema.ts
 */

type O11YSessionMetricsParams = {
  kiloUserId: string;
  organizationId?: string;
  sessionId: string;
  platform: string;
  sessionDurationMs: number;
  timeToFirstResponseMs?: number;
  totalTurns: number;
  totalSteps: number;
  toolCallsByType: Record<string, number>;
  toolErrorsByType: Record<string, number>;
  totalErrors: number;
  errorsByType: Record<string, number>;
  stuckToolCallCount: number;
  totalTokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  totalCost: number;
  compactionCount: number;
  autoCompactionCount: number;
  terminationReason: 'completed' | 'error' | 'interrupted' | 'abandoned' | 'unknown';
  ingestVersion: number;
};

type O11YBinding = Fetcher & {
  ingestSessionMetrics(params: O11YSessionMetricsParams): Promise<void>;
};
