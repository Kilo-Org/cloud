import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import type { EnkryptUsageQueueMessage, ExaUsageQueueMessage } from '@kilocode/usage-contracts';
import { logSafely, queueMetrics } from './diagnostics';
import { authorizePublish, type PublishAuthFields } from './publish-auth';
import type { Env } from './publish-usage';

type TaggedUsageQueueMessage = EnkryptUsageQueueMessage | ExaUsageQueueMessage;

export type TaggedUsageIngress<Message extends TaggedUsageQueueMessage> = {
  kind: Message['kind'];
  path: '/enkrypt-usage' | '/exa-usage';
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

/**
 * Sends once, to the dedicated tagged queue when the cutover switch is exactly `true`, otherwise
 * to the shared source queue. Tagged usage is never hedged, and a failed send, including a missing
 * dedicated binding, never falls back to the other queue or a direct write.
 */
async function enqueueTaggedUsage(
  env: Env,
  message: TaggedUsageQueueMessage,
  entryAtMs: number,
  auth: PublishAuthFields
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
    ...auth,
  }));
  const sendStartedAt = performance.now();
  let response: unknown;
  try {
    const queue =
      env.USAGE_INGEST_DEDICATED_TAGGED_QUEUE_ENABLED === 'true'
        ? env.USAGE_INGEST_ENKRYPT_QUEUE
        : env.USAGE_INGEST_QUEUE;
    response = await queue.send(message, { contentType: 'json' });
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
 * credential is checked before the body is read.
 */
export async function handlePublishTaggedUsage<Message extends TaggedUsageQueueMessage>(
  request: Request,
  env: Env,
  entryAtMs: number,
  ingress: TaggedUsageIngress<Message>,
  ctx: ExecutionContext | undefined
): Promise<Response> {
  const auth = await authorizePublish(request, env, ingress.path, ctx);
  if (auth instanceof Response) return auth;

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

  return enqueueTaggedUsage(env, parsed.message, entryAtMs, auth);
}
