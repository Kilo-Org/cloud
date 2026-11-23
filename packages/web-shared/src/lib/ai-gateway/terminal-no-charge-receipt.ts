import 'server-only';

import { isBenchmarkProjectId } from '@kilocode/auto-routing-contracts';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

/** The native usage writer, injected so this module stays free of the billing import graph. */
export type BenchmarkReceiptWriter = (
  stats: MicrodollarUsageStats,
  context: MicrodollarUsageContext
) => Promise<unknown>;

/** Defer work past the response; the caller passes `after` from `next/server`. */
export type DeferTask = (task: () => Promise<void>) => void;

/**
 * Record an authoritative zero-cost usage row for a benchmark call the gateway refused before
 * accounting could run.
 *
 * `respondToUpstream` answers a definitive upstream error from `applyUpstreamErrorPolicy` before
 * `accountForMicrodollarUsage`, so no usage row is ever written for that admitted call. The
 * Worker keeps an admitted model request without a receipt, and a later permit for that payer
 * stays blocked forever. The gateway proves no debit will run for this call, so it writes the
 * terminal no-charge row itself, keyed by the signed usage id:
 *
 * - the id is the assignment's, so the Worker reconciles the exact model request;
 * - the cost is exactly zero, so nothing is billed and no balance moves;
 * - it is written only for a benchmark context that names a real model request.
 *
 * Nothing here covers transport uncertainty: an aborted or unknown outcome never reaches this
 * caller, so it stays `pending` for the Worker.
 */
export function recordTerminalNoChargeReceipt(
  usageContext: MicrodollarUsageContext,
  statusCode: number,
  write: BenchmarkReceiptWriter,
  defer: DeferTask
): void {
  if (!usageContext.usageId || !isBenchmarkProjectId(usageContext.project_id)) return;
  if (!usageContext.requested_model || !usageContext.api_kind) return;
  const usageId = usageContext.usageId;
  defer(async () => {
    try {
      await write(
        {
          messageId: null,
          model: usageContext.requested_model,
          responseContent: '',
          hasError: true,
          inference_provider: null,
          upstream_id: null,
          finish_reason: null,
          latency: null,
          moderation_latency: null,
          generation_time: null,
          streamed: usageContext.isStreaming,
          cancelled: false,
          status_code: statusCode,
          cost_mUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheHitTokens: 0,
          is_byok: false,
        },
        // Keep the signed id so the Worker's receipt read matches this exact model request.
        { ...usageContext, usageId }
      );
    } catch (error) {
      console.error('Failed to write the benchmark terminal no-charge receipt', {
        usageId,
        errorType: error instanceof Error ? error.name : 'unknown',
      });
    }
  });
}
