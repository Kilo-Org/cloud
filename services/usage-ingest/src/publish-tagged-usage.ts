import { timingSafeEqual } from '@kilocode/encryption';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import type { EnkryptUsageQueueMessage, ExaUsageQueueMessage } from '@kilocode/usage-contracts';
import { logSafely, queueMetrics } from './diagnostics';
import type { Env } from './publish-usage';

type TaggedUsageQueueMessage = EnkryptUsageQueueMessage | ExaUsageQueueMessage;

export type TaggedUsageIngress<Message extends TaggedUsageQueueMessage> = {
  kind: Message['kind'];
  maxBytes: number;
  /** Wraps a valid bare record in its envelope, or returns the bounded rejection log fields. */
  toMessage(value: unknown): { message: Message } | { rejection: object };
};

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

async function readTaggedBody(
  request: Request,
  maxBytes: number,
  logRejected: (category: string, details?: object) => void
): Promise<{ value: unknown } | Response> {
  if (!request.body) {
    logRejected('missing_body');
    return errorResponse('Invalid JSON', 400);
  }
  let category = 'body_read_failure';
  try {
    const read = await readBoundedStream(request.body as ReadableStream<Uint8Array>, maxBytes);
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

async function enqueueTaggedUsage(
  env: Env,
  message: TaggedUsageQueueMessage,
  entryAtMs: number
): Promise<Response> {
  const usageId = message.record.id;
  const kindFields = { usage_kind: message.kind };
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
    // which the writer for that kind deduplicates.
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
 * Accepts one bare record of a tagged kind on the path that names it, so only this ingress builds
 * the envelope; an envelope-shaped body is rejected by the strict record schema. The publish
 * secret is checked before the body is read.
 */
export async function handlePublishTaggedUsage<Message extends TaggedUsageQueueMessage>(
  request: Request,
  env: Env,
  entryAtMs: number,
  ingress: TaggedUsageIngress<Message>
): Promise<Response> {
  const secret = env.USAGE_INGEST_PUBLISH_SECRET;
  if (!secret) return errorResponse('Service unavailable', 503);
  const authorization = request.headers.get('Authorization');
  if (!authorization || !timingSafeEqual(authorization, `Bearer ${secret}`)) {
    return errorResponse('Unauthorized', 401);
  }

  const logRejected = (category: string, details: object = {}) =>
    logSafely('warn', () => ({
      event: 'usage_ingest_rejected',
      usage_kind: ingress.kind,
      category,
      ...details,
    }));
  const body = await readTaggedBody(request, ingress.maxBytes, logRejected);
  if (body instanceof Response) return body;
  const parsed = ingress.toMessage(body.value);
  if ('rejection' in parsed) {
    logRejected('schema_failure', parsed.rejection);
    return errorResponse('Invalid usage payload', 400);
  }

  return enqueueTaggedUsage(env, parsed.message, entryAtMs);
}
