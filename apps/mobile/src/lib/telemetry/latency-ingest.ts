import { LATENCY_INGEST_URL } from '@/lib/config';
import { buildAuthHeaders } from '@/lib/auth/auth-header';
import { buildClientMetadataHeaders } from '@/lib/client-metadata';
import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { type LatencyBatch } from '@/lib/telemetry/request-latency';

/**
 * Path the latency-ingest worker answers on. The worker 404s every other
 * pathname, so this must match `services/latency-ingest/src/ingest.ts:67`
 * (`url.pathname !== '/v1/latency'`). The configured value stays the service
 * base URL.
 */
const LATENCY_INGEST_PATH = '/v1/latency';

/**
 * Resolve the ingest worker URL from the configured service base URL. A base
 * that already ends in `/v1/latency` is returned unchanged. An unparseable
 * base is returned as-is so the caller posts to exactly what was configured.
 */
export function resolveLatencyIngestUrl(base: string): string {
  try {
    return new URL(LATENCY_INGEST_PATH, base).toString();
  } catch {
    return base;
  }
}

/**
 * Deliver one buffered latency batch to the ingest endpoint. No-op when the
 * endpoint is unset or the batch is empty. Uses the global `fetch` — never the
 * measured/observed wrapper — so a telemetry POST is not itself sampled,
 * reported as a user error, or recursive. Any non-success outcome (network
 * failure, 4xx, 5xx) drops the batch and returns quietly: telemetry must never
 * surface in the UI. No userId is sent.
 */
export async function postLatencyBatch(batch: LatencyBatch): Promise<void> {
  if (!LATENCY_INGEST_URL || batch.samples.length === 0) {
    return;
  }
  try {
    const token = await getAuthTokenForRequest();
    await fetch(resolveLatencyIngestUrl(LATENCY_INGEST_URL), {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(token),
        ...buildClientMetadataHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ samples: batch.samples }),
    });
  } catch {
    // Telemetry must never surface in the UI; drop the batch quietly.
  }
}
