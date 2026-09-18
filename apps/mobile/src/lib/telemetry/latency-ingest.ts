import { LATENCY_INGEST_URL } from '@/lib/config';
import { buildAuthHeaders } from '@/lib/auth/auth-header';
import { buildClientMetadataHeaders } from '@/lib/client-metadata';
import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { type LatencyBatch } from '@/lib/telemetry/request-latency';

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
    await fetch(LATENCY_INGEST_URL, {
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
