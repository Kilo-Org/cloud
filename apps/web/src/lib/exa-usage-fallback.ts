import 'server-only';

import { ExaUsageRecordSchema, type ExaUsageRecord } from '@kilocode/usage-contracts';
import {
  EXA_USAGE_INGEST_PUBLISH_SECRET,
  EXA_USAGE_INGEST_URL,
  EXA_USAGE_QUEUE_FALLBACK,
} from '@kilocode/web-shared/lib/config.server';

/**
 * Long enough to outlast most short Cloudflare Queues send stalls, short enough that a
 * failed fallback does not hold the request's `after()` work open for long.
 */
export const EXA_USAGE_FALLBACK_TIMEOUT_MS = 10_000;

export type ExaUsageFallbackConfig = {
  enabled: boolean;
  url: string | undefined;
  secret: string | undefined;
};

export type ExaUsageFallbackResult =
  | { fallback: 'disabled' | 'not_configured' | 'invalid_record' | 'published' }
  | { fallback: 'timeout' | 'request_failed'; fallback_error: string }
  | { fallback: 'rejected' | 'http_error'; fallback_status: number };

export function exaUsageFallbackConfig(): ExaUsageFallbackConfig {
  return {
    enabled: EXA_USAGE_QUEUE_FALLBACK === 'true',
    url: EXA_USAGE_INGEST_URL,
    secret: EXA_USAGE_INGEST_PUBLISH_SECRET,
  };
}

/** `DOMException`, such as a fetch timeout, is not always an `Error` instance across realms. */
function errorName(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
    ? error.name
    : typeof error;
}

function ingressUrl(value: string | undefined): string | null {
  if (!value || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
}

/**
 * Sends one copy of a record whose direct write failed to the usage-ingest `/exa-usage`
 * path, for the shared usage queue to retry durably. It makes exactly one attempt and never
 * writes directly: the queued copy carries the same `id` and `occurredAt`, so if the failed
 * direct write had in fact committed, the writer answers `duplicate` without a second debit.
 */
export async function publishExaUsageFallback(
  record: ExaUsageRecord,
  config: ExaUsageFallbackConfig = exaUsageFallbackConfig(),
  fetchImpl: typeof fetch = fetch
): Promise<ExaUsageFallbackResult> {
  if (!config.enabled) return { fallback: 'disabled' };
  const url = ingressUrl(config.url);
  if (!url || !config.secret) return { fallback: 'not_configured' };
  const parsed = ExaUsageRecordSchema.safeParse(record);
  if (!parsed.success) return { fallback: 'invalid_record' };

  const signal = AbortSignal.timeout(EXA_USAGE_FALLBACK_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.secret}`,
      },
      body: JSON.stringify(parsed.data),
      signal,
    });
  } catch (error) {
    // Only the error name is kept: the message can echo the ingress URL.
    return {
      fallback: signal.aborted ? 'timeout' : 'request_failed',
      fallback_error: errorName(error),
    };
  }
  if (response.status === 202) return { fallback: 'published' };
  if (response.status === 400) return { fallback: 'rejected', fallback_status: 400 };
  return { fallback: 'http_error', fallback_status: response.status };
}
