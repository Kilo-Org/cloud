import { timingSafeEqual } from '@kilocode/encryption';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import type { EnkryptUsageQueueMessage, ExaUsageQueueMessage } from '@kilocode/usage-contracts';
import { logSafely, queueMetrics } from './diagnostics';
import type { Env } from './publish-usage';

/** A tagged record is a few hundred bytes, so its envelope stays far below the queue limit. */
export const MAX_TAGGED_USAGE_BYTES = 8_192;

type TaggedUsageMessage = EnkryptUsageQueueMessage | ExaUsageQueueMessage;
type KindFields = { usage_kind: TaggedUsageMessage['kind'] };

type RecordParse<Record> =
  | { success: true; data: Record }
  | { success: false; error: { issues: { path: PropertyKey[]; code: string }[] } };

/**
 * One tagged ingress path. The path names the kind, so only this ingress builds the envelope; an
 * envelope-shaped body is rejected by the strict record schema.
 */
export type TaggedUsageIngress<Message extends TaggedUsageMessage> = {
  kind: Message['kind'];
  secret: (env: Env) => string | undefined;
  parse: (value: unknown) => RecordParse<Message['record']>;
  rejectionDetails: (error: { issues: { path: PropertyKey[]; code: string }[] }) => object;
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

function logRejected(kindFields: KindFields, category: string, details: object = {}): void {
  logSafely('warn', () => ({
    event: 'usage_ingest_rejected',
    ...kindFields,
    category,
    ...details,
  }));
}

async function readTaggedBody(
  request: Request,
  kindFields: KindFields
): Promise<{ value: unknown } | Response> {
  if (!request.body) {
    logRejected(kindFields, 'missing_body');
    return errorResponse('Invalid JSON', 400);
  }
  let category = 'body_read_failure';
  try {
    const read = await readBoundedStream(
      request.body as ReadableStream<Uint8Array>,
      MAX_TAGGED_USAGE_BYTES
    );
    if (!read.ok) return errorResponse('Usage payload too large', 413);
    category = 'invalid_utf8';
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(read.bytes);
    category = 'malformed_json';
    return { value: JSON.parse(text) };
  } catch (error) {
    // `category` names the stage that failed. Only the error name is logged: its message can
    // quote the body.
    logRejected(kindFields, category, { error_name: errorName(error) });
    return errorResponse('Invalid JSON', 400);
  }
}

async function enqueueTaggedUsage(
  env: Env,
  message: TaggedUsageMessage,
  entryAtMs: number
): Promise<Response> {
  const usageId = message.record.id;
  const kindFields: KindFields = { usage_kind: message.kind };
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
    // which the kind's writer deduplicates.
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

/** Authenticates with the ingress's own secret before the body is read. */
export async function handlePublishTaggedUsage<Message extends TaggedUsageMessage>(
  request: Request,
  env: Env,
  entryAtMs: number,
  ingress: TaggedUsageIngress<Message>
): Promise<Response> {
  const secret = ingress.secret(env);
  if (!secret) return errorResponse('Service unavailable', 503);
  const authorization = request.headers.get('Authorization');
  if (!authorization || !timingSafeEqual(authorization, `Bearer ${secret}`)) {
    return errorResponse('Unauthorized', 401);
  }

  const kindFields: KindFields = { usage_kind: ingress.kind };
  const body = await readTaggedBody(request, kindFields);
  if (body instanceof Response) return body;
  const result = ingress.parse(body.value);
  if (!result.success) {
    logRejected(kindFields, 'schema_failure', ingress.rejectionDetails(result.error));
    return errorResponse('Invalid usage payload', 400);
  }

  // `Message` ties the kind to its record type, which TypeScript cannot rebuild from parts.
  const message = { kind: ingress.kind, v: 1, record: result.data } as TaggedUsageMessage;
  return enqueueTaggedUsage(env, message, entryAtMs);
}
