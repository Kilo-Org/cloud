import type { AuditEvent } from '@kilocode/sts-contracts';
import { errorName } from './error-name';

export type AxiomIngestConfig = { url: string; dataset: string; token: string };

export type AxiomIngestResult =
  | { kind: 'ok' }
  | { kind: 'retryable'; detail: string }
  | { kind: 'rejected'; status: number };

const RETRYABLE_STATUSES = new Set([401, 403, 408, 429]);

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
    return { kind: 'retryable', detail: errorName(error) };
  }

  await response.body?.cancel();
  if (response.ok) return { kind: 'ok' };
  // 401 and 403 follow a token rotation until the secrets client revalidates (at most 240 s),
  // so they retry like an outage instead of turning every batch into a paged hot-store gap.
  if (RETRYABLE_STATUSES.has(response.status) || response.status >= 500) {
    return { kind: 'retryable', detail: `http_${response.status}` };
  }
  return { kind: 'rejected', status: response.status };
}
