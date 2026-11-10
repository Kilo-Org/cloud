import { timingSafeEqual } from '@kilocode/encryption';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import { EnkryptUsageWriteSchema, type EnkryptUsageQueueMessage } from '@kilocode/usage-contracts';
import { logSafely, queueMetrics } from './diagnostics';
import type { Env } from './publish-usage';
import { enkryptSchemaRejectionDetails } from './rejection-diagnostics';

/** An Enkrypt record is a few hundred bytes, so its envelope stays far below the queue limit. */
export const MAX_ENKRYPT_USAGE_BYTES = 8_192;

const kindFields = { usage_kind: 'enkrypt_usage' } as const;

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/** `DOMException` is not always an `Error` instance across realms. */
function errorName(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
    ? error.name
    : typeof error;
}

function logRejected(category: string, details: object = {}): void {
  logSafely('warn', () => ({
    event: 'usage_ingest_rejected',
    ...kindFields,
    category,
    ...details,
  }));
}

async function readEnkryptBody(request: Request): Promise<{ value: unknown } | Response> {
  if (!request.body) {
    logRejected('missing_body');
    return errorResponse('Invalid JSON', 400);
  }
  let category = 'body_read_failure';
  try {
    const read = await readBoundedStream(
      request.body as ReadableStream<Uint8Array>,
      MAX_ENKRYPT_USAGE_BYTES
    );
    if (!read.ok) return errorResponse('Usage payload too large', 413);
    category = 'invalid_utf8';
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(read.bytes);
    category = 'malformed_json';
    return { value: JSON.parse(text) };
  } catch (error) {
    // `category` names the stage that failed. Only the error name is logged: its message can
    // quote the body.
    logRejected(category, { error_name: errorName(error) });
    return errorResponse('Invalid JSON', 400);
  }
}

async function enqueueEnkryptUsage(
  env: Env,
  message: EnkryptUsageQueueMessage,
  entryAtMs: number
): Promise<Response> {
  const usageId = message.record.id;
  const beforeSendAtMs = Date.now();
  logSafely('info', () => ({
    event: 'usage_ingest_enqueue_start',
    usage_id: usageId,
    ...kindFields,
    publisher_entry_at_ms: entryAtMs,
    before_send_at_ms: beforeSendAtMs,
  }));
  const sendStartedAt = performance.now();
  let response: unknown;
  try {
    response = await env.USAGE_INGEST_QUEUE.send(message, { contentType: 'json' });
  } catch (error) {
    // The send may still have enqueued. The 503 lets the producer resend the same usage id,
    // which the Enkrypt writer deduplicates.
    logSafely('warn', () => ({
      event: 'usage_ingest_enqueue',
      usage_id: usageId,
      ...kindFields,
      outcome: 'unavailable',
      error_name: errorName(error),
      after_send_at_ms: Date.now(),
      send_duration_ms: Math.round(performance.now() - sendStartedAt),
    }));
    return errorResponse('Queue unavailable', 503);
  }
  logSafely('info', () => ({
    event: 'usage_ingest_enqueue',
    usage_id: usageId,
    ...kindFields,
    outcome: 'accepted',
    publisher_entry_at_ms: entryAtMs,
    before_send_at_ms: beforeSendAtMs,
    after_send_at_ms: Date.now(),
    send_duration_ms: Math.round(performance.now() - sendStartedAt),
    ...queueMetrics(response),
  }));
  return new Response(null, { status: 202 });
}

/**
 * The gateway, the only Enkrypt producer, already holds the LLM publish secret, so accepting it
 * here adds no new secret holder. The path names the kind, so only this ingress builds the
 * envelope; an envelope-shaped body is rejected by the strict record schema.
 */
export async function handlePublishEnkryptUsage(
  request: Request,
  env: Env,
  entryAtMs: number
): Promise<Response> {
  const secret = env.USAGE_INGEST_PUBLISH_SECRET;
  if (!secret) return errorResponse('Service unavailable', 503);
  const authorization = request.headers.get('Authorization');
  if (!authorization || !timingSafeEqual(authorization, `Bearer ${secret}`)) {
    return errorResponse('Unauthorized', 401);
  }

  const body = await readEnkryptBody(request);
  if (body instanceof Response) return body;
  const result = EnkryptUsageWriteSchema.safeParse(body.value);
  if (!result.success) {
    logRejected('schema_failure', enkryptSchemaRejectionDetails(result.error));
    return errorResponse('Invalid usage payload', 400);
  }

  return enqueueEnkryptUsage(env, { kind: 'enkrypt_usage', v: 1, record: result.data }, entryAtMs);
}
