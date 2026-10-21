import 'server-only';

import {
  USAGE_INGEST_URL,
  USAGE_INGEST_PUBLISH_SECRET,
} from '@kilocode/web-shared/lib/config.server';
import type { UsageRecordRequest } from '@kilocode/usage-contracts';

export const USAGE_ENQUEUE_TIMEOUT_MS = 2_000;
export const USAGE_ENQUEUE_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 200;

export type UsageEnqueueOutcome =
  | { kind: 'disabled' }
  | { kind: 'accepted' }
  | { kind: 'unavailable'; reason: string };

function reportUnavailable(usageId: string, reason: string): UsageEnqueueOutcome {
  const outcome = { kind: 'unavailable', reason } as const;
  console.warn('usage enqueue unavailable', { usageId, ...outcome });
  return outcome;
}

/** HTTP 202 confirms enqueueing, not a committed usage row. */
export async function enqueueUsage(
  payload: UsageRecordRequest,
  { retryTransientFailures = false }: { retryTransientFailures?: boolean } = {}
): Promise<UsageEnqueueOutcome> {
  if (!USAGE_INGEST_URL || !USAGE_INGEST_PUBLISH_SECRET) return { kind: 'disabled' };

  let url: string;
  let body: string;
  try {
    url = new URL(USAGE_INGEST_URL).toString();
    body = JSON.stringify(payload);
  } catch {
    return reportUnavailable(payload.core.id, 'request_failed');
  }

  const maxAttempts = retryTransientFailures ? USAGE_ENQUEUE_MAX_ATTEMPTS : 1;
  let reason = 'request_failed';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const signal = AbortSignal.timeout(USAGE_ENQUEUE_TIMEOUT_MS);
    let retryable: boolean;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${USAGE_INGEST_PUBLISH_SECRET}`,
        },
        body,
        signal,
        cache: 'no-store',
        redirect: 'manual',
      });
      // Cancel unused bodies without allowing asynchronous cleanup failures to change acceptance.
      void response.body?.cancel().catch(() => {});
      if (response.status === 202) return { kind: 'accepted' };
      reason = `http_${response.status}`;
      retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    } catch {
      reason = signal.aborted ? 'timeout' : 'request_failed';
      retryable = true;
    }

    if (!retryable || attempt === maxAttempts) break;
    console.warn('usage enqueue retrying', { usageId: payload.core.id, reason, attempt });
    await new Promise(resolve =>
      setTimeout(resolve, RETRY_BASE_DELAY_MS * attempt + Math.random() * RETRY_BASE_DELAY_MS)
    );
  }

  return reportUnavailable(payload.core.id, reason);
}
