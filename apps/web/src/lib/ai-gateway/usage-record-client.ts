import 'server-only';

import { captureException } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { APP_URL } from '@/lib/constants';
import type { UsageRecordInsertResult } from './processUsage';
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

/** Per-attempt budget. Runs inside `after()`, so keep the total bounded. */
const ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 200;

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

/** 4xx other than 429 means the payload or auth is wrong; retrying cannot help. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
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
        const parsed = UsageRecordResponseSchema.safeParse(await response.json());
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
