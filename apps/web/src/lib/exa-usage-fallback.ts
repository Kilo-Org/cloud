import 'server-only';

import type { ExaUsageRecord } from '@kilocode/usage-contracts';
import {
  enqueueExaUsage,
  isExaUsagePublicationConfigured,
} from '@kilocode/web-shared/lib/ai-gateway/usage-publisher';
import {
  unexpectedRejection,
  type PublicationOutcome,
} from '@kilocode/web-shared/lib/ai-gateway/usage-publication-outcome';

export type ExaUsageFallbackOutcome =
  | { fallback: 'not_configured' | 'queued' }
  | { fallback: 'rejected' | 'publish_failed'; fallback_reason: string }
  | {
      fallback: 'publish_failed';
      fallback_reason: 'unexpected_rejection';
      fallback_error_name: string;
    };

/**
 * Whether a failed direct write can still reach durable storage through the queue. Callers use
 * this to reserve invocation time only for a publication that can actually happen.
 */
export function isExaUsageQueueFallbackAvailable(): boolean {
  return isExaUsagePublicationConfigured();
}

/**
 * Called only after the direct write of `record` failed. Sends that same record once to the usage
 * queue, whose writer deduplicates by `id` and `occurredAt`, so a direct write that had in fact
 * committed is answered `duplicate` without a second debit. The direct write is never repeated, and
 * every failure is returned as an outcome rather than thrown.
 */
export async function queueExaUsageAfterFailedWrite(
  record: ExaUsageRecord
): Promise<ExaUsageFallbackOutcome> {
  let outcome: PublicationOutcome;
  try {
    outcome = await enqueueExaUsage(record);
  } catch (error) {
    outcome = unexpectedRejection(error);
  }
  if (outcome.kind === 'accepted') return { fallback: 'queued' };
  if ('errorName' in outcome) {
    return {
      fallback: 'publish_failed',
      fallback_reason: outcome.reason,
      fallback_error_name: outcome.errorName,
    };
  }
  if (outcome.reason === 'publisher_not_configured') return { fallback: 'not_configured' };
  if (outcome.reason === 'http_400') return { fallback: 'rejected', fallback_reason: 'http_400' };
  return { fallback: 'publish_failed', fallback_reason: outcome.reason };
}
