import 'server-only';

import {
  USAGE_INGEST_URL,
  USAGE_INGEST_PUBLISH_SECRET,
} from '@kilocode/web-shared/lib/config.server';
import type { UsageRecordRequest } from '@kilocode/usage-contracts';
import { enqueueVercelUsage } from '@kilocode/usage-queue/vercel/publisher';
import { USAGE_VERCEL_QUEUE_ENABLED } from '@kilocode/usage-queue/vercel/config';

export const USAGE_ENQUEUE_TIMEOUT_MS = 2_000;
export const USAGE_ENQUEUE_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 200;

/**
 * `publisher_not_configured` means no publisher URL or secret is set, so nothing was attempted.
 * It is an operator error rather than a transport failure.
 */
export type UsageEnqueueOutcome = { kind: 'accepted' } | { kind: 'unavailable'; reason: string };

function reportUnavailable(
  usageId: string,
  reason: string,
  duplicatePossible = false
): UsageEnqueueOutcome {
  const outcome = { kind: 'unavailable', reason } as const;
  console.warn('usage enqueue unavailable', {
    usageId,
    ...outcome,
    ...(duplicatePossible && { duplicate_possible: true }),
  });
  return outcome;
}

/**
 * `fetch` only speaks http(s). `new URL` accepts any `scheme:`, so a value like
 * `localhost:3000/usage` parses as a `localhost:` URL with no host and would fail every
 * attempt. Reject it as configuration before any request is made.
 */
function parsePublisherUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** HTTP 202 confirms enqueueing, not a committed usage row. */
export async function enqueueUsage(
  payload: UsageRecordRequest,
  { retryTransientFailures = false }: { retryTransientFailures?: boolean } = {}
): Promise<UsageEnqueueOutcome> {
  if (USAGE_VERCEL_QUEUE_ENABLED) {
    return enqueueVercelUsage(payload);
  }
  if (!USAGE_INGEST_URL || !USAGE_INGEST_PUBLISH_SECRET) {
    return reportUnavailable(payload.core.id, 'publisher_not_configured');
  }

  // A URL that is not an absolute http(s) endpoint is configuration, not transport: no
  // request is attempted, so the caller must fall back exactly like a missing publisher.
  const parsedUrl = parsePublisherUrl(USAGE_INGEST_URL);
  if (!parsedUrl) return reportUnavailable(payload.core.id, 'publisher_not_configured');
  const url = parsedUrl.toString();

  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    // A validated usage record always serializes; keep the honest reason if it ever does not.
    return reportUnavailable(payload.core.id, 'request_failed');
  }

  const maxAttempts = retryTransientFailures ? USAGE_ENQUEUE_MAX_ATTEMPTS : 1;
  let reason = 'request_failed';
  let duplicatePossible = false;
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
      // 408 and 429 refuse the request before it is enqueued. A 5xx can follow a
      // `Queue.send` that stored the message before failing, or an edge failure after
      // the Worker ran, so like a lost response it may hide an accepted event.
      duplicatePossible ||= response.status >= 500;
      retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    } catch {
      reason = signal.aborted ? 'timeout' : 'request_failed';
      duplicatePossible = true;
      retryable = true;
    }

    if (!retryable || attempt === maxAttempts) break;
    console.warn('usage enqueue retrying', {
      usageId: payload.core.id,
      reason,
      attempt,
      ...(duplicatePossible && { duplicate_possible: true }),
    });
    await new Promise(resolve =>
      setTimeout(resolve, RETRY_BASE_DELAY_MS * attempt + Math.random() * RETRY_BASE_DELAY_MS)
    );
  }

  return reportUnavailable(payload.core.id, reason, duplicatePossible);
}
