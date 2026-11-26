import type { AuditEvent } from '@kilocode/sts-contracts';
import { errorName } from './error-name';

export type AxiomIngestConfig = { url: string; dataset: string; token: string };

/**
 * `unavailable`: transient (network, 5xx, 408, 429, and 401/403, which follow a token rotation
 * until the secrets client revalidates, at most 240 s). `refused`: any other 4xx, such as a
 * missing or renamed dataset (404); it is about the destination, not the payload.
 * `payload_rejected`: 400, 413 or 422, the statuses about the request body; the StreamDO decides
 * whether that is one bad row or a stream-wide problem.
 */
export type AxiomIngestResult =
  | { kind: 'ok' }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'refused'; status: number }
  | { kind: 'payload_rejected'; status: number };

const TRANSIENT_STATUSES = new Set([401, 403, 408, 429]);
const PAYLOAD_STATUSES = new Set([400, 413, 422]);

/**
 * The hot copy. Events keep their `id` so a downstream reader can dedupe at-least-once delivery;
 * `_time` is Axiom's event-time field and comes from the CloudEvents `time`.
 */
export async function ingestAuditEvents(
  config: AxiomIngestConfig,
  events: readonly AuditEvent[],
  http: typeof fetch
): Promise<AxiomIngestResult> {
  const body = events.map(event => ({ ...event, _time: event.time }));
  let response: Response;
  try {
    response = await http(
      `${config.url}/v1/datasets/${encodeURIComponent(config.dataset)}/ingest`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );
  } catch (error) {
    return { kind: 'unavailable', detail: errorName(error) };
  }

  await response.body?.cancel();
  if (response.ok) return { kind: 'ok' };
  if (TRANSIENT_STATUSES.has(response.status) || response.status >= 500) {
    return { kind: 'unavailable', detail: `http_${response.status}` };
  }
  if (PAYLOAD_STATUSES.has(response.status)) {
    return { kind: 'payload_rejected', status: response.status };
  }
  return { kind: 'refused', status: response.status };
}
