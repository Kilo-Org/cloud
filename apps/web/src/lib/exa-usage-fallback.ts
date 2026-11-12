import 'server-only';

import type { ExaUsageRecord } from '@kilocode/usage-contracts';
import { EXA_USAGE_QUEUE_FALLBACK_ENABLED } from '@kilocode/web-shared/lib/config.server';
import {
  enqueueExaUsage,
  type UsageEnqueueOutcome,
} from '@kilocode/web-shared/lib/ai-gateway/usage-publisher';

export type ExaUsageFallbackOutcome =
  | { fallback: 'disabled' | 'not_configured' | 'queued' }
  | { fallback: 'rejected' | 'publish_failed'; fallback_reason: string }
  | {
      fallback: 'publish_failed';
      fallback_reason: 'unexpected_rejection';
      fallback_error_name: string;
    };

type PublicationOutcome =
  | UsageEnqueueOutcome
  | { kind: 'unavailable'; reason: 'unexpected_rejection'; errorName: string };

/**
 * The publisher reports every transport failure as an outcome, so a rejection is unexpected; only
 * the error's name is kept, because its message can carry the ingress URL.
 */
function unexpectedRejection(error: unknown): PublicationOutcome {
  return {
    kind: 'unavailable',
    reason: 'unexpected_rejection',
    errorName: error instanceof Error ? error.name : typeof error,
  };
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
  if (!EXA_USAGE_QUEUE_FALLBACK_ENABLED) return { fallback: 'disabled' };

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
