import 'server-only';

import { captureException } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { APP_URL } from '@/lib/constants';
import type { UsageRecordInsertResult } from './processUsage.types';
import { UsageRecordResponseSchema, type UsageRecordRequest } from './usage-record-contract';

/**
 * Client for handing the AI-gateway usage write to a Frankfurt-local endpoint.
 *
 * `APP_URL` resolves to the Frankfurt-only `kilocode-app` deployment in
 * production. Its `next.config.mjs` rewrites divert only the six listed gateway
 * paths to `global-api.kilo.ai`, so `/api/internal/*` executes locally there,
 * next to the PostgreSQL primary.
 */

const USAGE_RECORD_PATH = '/api/internal/usage/record';

/**
 * Per-attempt budget. Runs inside `after()`, so the total stays bounded, and it
 * must stay under the endpoint's `maxDuration` of 150s.
 *
 * This was 10s, which was below the endpoint's actual p95 of roughly 50s. Every
 * request slower than the timeout was abandoned and re-sent with the same
 * `core.id`, so ~20% of deliveries became redeliveries that collided on the
 * `microdollar_usage` primary key — about 4,400 collisions per five minutes — and
 * each retry added load that made the endpoint slower still. Keep this
 * comfortably above the observed tail.
 */
export const ATTEMPT_TIMEOUT_MS = 90_000;
const RETRY_BASE_DELAY_MS = 200;
export const MAX_ATTEMPTS = 2;

/**
 * `unavailable` tells the caller to fall back to writing locally. A slow
 * cross-region write is strictly better than a lost billing record, so every
 * exhausted-retry and misconfiguration path degrades to the local write rather
 * than dropping the usage row.
 */
export type RemoteUsageRecordOutcome =
  | { kind: 'ok'; result: UsageRecordInsertResult | null }
  | { kind: 'unavailable'; reason: string };

function retryDelayMs(attempt: number): number {
  return RETRY_BASE_DELAY_MS * attempt + Math.random() * RETRY_BASE_DELAY_MS;
}

/**
 * Only statuses that prove the request never reached the write.
 *
 * 429 and 503 are refusals, and a 502 means the gateway never got a response from
 * a function that therefore did not run. A 500 is the opposite: our handler threw,
 * possibly after the transaction committed, so re-sending risks a redelivery for
 * no benefit. 504 is likewise ambiguous. 4xx other than 429 means the payload or
 * auth is wrong, which a retry cannot fix.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503;
}

/**
 * A timeout is never retried. The endpoint may still be mid-write, so re-sending
 * produces exactly the primary-key collision this client used to cause. Falling
 * back to a local write is the safer response: it is slower, but the endpoint's
 * own conflict handling recognises the collision and recovers the identity.
 */
function isRetryableError(error: unknown): boolean {
  return !(error instanceof Error) || error.name !== 'TimeoutError';
}

export async function recordUsageInPrimaryRegion(
  payload: UsageRecordRequest
): Promise<RemoteUsageRecordOutcome> {
  if (!INTERNAL_API_SECRET) {
    return { kind: 'unavailable', reason: 'missing_internal_api_secret' };
  }
  if (!APP_URL) {
    return { kind: 'unavailable', reason: 'missing_app_url' };
  }

  const url = new URL(USAGE_RECORD_PATH, APP_URL).toString();
  const body = JSON.stringify(payload);
  let lastReason = 'unknown';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': INTERNAL_API_SECRET,
        },
        body,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        cache: 'no-store',
      });

      if (!response.ok) {
        lastReason = `http_${response.status}`;
        if (!isRetryableStatus(response.status)) break;
      } else {
        // Read the body inside its own guard. A truncated or non-JSON body throws
        // here, and the outer catch would treat that as a retryable transport
        // failure — but the status was already 2xx, so the write may have
        // committed, exactly like the schema mismatch below. Both must fall back
        // rather than re-send and manufacture a redelivery.
        let responseBody: unknown;
        try {
          responseBody = await response.json();
        } catch {
          lastReason = 'unreadable_response';
          break;
        }
        const parsed = UsageRecordResponseSchema.safeParse(responseBody);
        if (!parsed.success) {
          // A malformed response is not safe to retry: the write may well have
          // committed. Fall back so the caller can reconcile on `core.id`.
          lastReason = 'malformed_response';
          break;
        }
        // `duplicate` means an earlier attempt of this same delivery already
        // committed, so the row exists and its side effects ran. Treat as success.
        return { kind: 'ok', result: parsed.data.result };
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.name : 'fetch_failed';
      if (!isRetryableError(error)) break;
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }

  // Visibility for the failure mode this indirection introduces. Without this,
  // a Frankfurt endpoint outage looks like ordinary cross-region slowness.
  console.error('usage record handoff to primary region failed; falling back to local write', {
    reason: lastReason,
    usageId: payload.core.id,
  });
  captureException(new Error('usage record handoff to primary region failed'), {
    tags: { source: 'recordUsageInPrimaryRegion', reason: lastReason },
    extra: { usageId: payload.core.id },
  });

  return { kind: 'unavailable', reason: lastReason };
}
