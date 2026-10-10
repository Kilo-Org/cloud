import 'server-only';

import {
  USAGE_INGEST_URL,
  USAGE_INGEST_PUBLISH_SECRET,
} from '@kilocode/web-shared/lib/config.server';
import type { UsageRecordRequest } from '@kilocode/usage-contracts';

export const USAGE_ENQUEUE_TIMEOUT_MS = 2_000;

export type UsageEnqueueOutcome =
  | { kind: 'disabled' }
  | { kind: 'accepted' }
  | { kind: 'unavailable'; reason: string };

/** Enqueues usage through the authenticated endpoint; currently has no gateway callers. */
export async function enqueueUsage(payload: UsageRecordRequest): Promise<UsageEnqueueOutcome> {
  if (!USAGE_INGEST_URL || !USAGE_INGEST_PUBLISH_SECRET) return { kind: 'disabled' };

  const signal = AbortSignal.timeout(USAGE_ENQUEUE_TIMEOUT_MS);
  let outcome: UsageEnqueueOutcome;
  try {
    const url = new URL(USAGE_INGEST_URL).toString();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${USAGE_INGEST_PUBLISH_SECRET}`,
      },
      body: JSON.stringify(payload),
      signal,
      cache: 'no-store',
      redirect: 'error',
    });
    // Only the status is needed. Cancel the unused body without letting cleanup failures
    // change a confirmed acceptance or become unhandled rejections.
    void response.body?.cancel().catch(() => {});
    if (response.status === 202) return { kind: 'accepted' };
    outcome = { kind: 'unavailable', reason: `http_${response.status}` };
  } catch {
    outcome = { kind: 'unavailable', reason: signal.aborted ? 'timeout' : 'request_failed' };
  }

  console.warn('usage enqueue unavailable', { usageId: payload.core.id, ...outcome });
  return outcome;
}
