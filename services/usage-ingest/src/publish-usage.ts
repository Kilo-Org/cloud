import { timingSafeEqual } from '@kilocode/encryption';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import { UsageRecordRequestSchema, type UsageQueueMessage } from '@kilocode/usage-contracts';
import { logSafely, queueMetrics } from './diagnostics';
import { handlePublishEnkryptUsage } from './publish-enkrypt-usage';
import { schemaRejectionDetails } from './rejection-diagnostics';

export type Env = Omit<
  CloudflareEnv,
  'USAGE_INGEST_QUEUE' | 'USAGE_WRITER_URL' | 'USAGE_INGEST_PARALLELISM'
> & {
  USAGE_INGEST_QUEUE: Queue<UsageQueueMessage>;
  USAGE_INGEST_PUBLISH_SECRET?: string;
  USAGE_INGEST_PARALLELISM?: string;
  USAGE_WRITER_URL?: string;
  USAGE_WRITER_SECRET?: string;
  USAGE_WRITER_PROTECTION_BYPASS?: string;
};

// Queues allow 128,000 bytes including internal metadata; leave 8,000 bytes of headroom.
export const MAX_USAGE_BYTES = 120_000;

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

async function readUsageBody(request: Request) {
  if (!request.body) {
    logSafely('warn', () => ({ event: 'usage_ingest_rejected', category: 'missing_body' }));
    return { error: errorResponse('Invalid JSON', 400) };
  }

  // Track the current stage so the catch can classify failures without logging error text.
  let category = 'body_read_failure';
  try {
    const result = await readBoundedStream(
      request.body as ReadableStream<Uint8Array>,
      MAX_USAGE_BYTES
    );
    if (!result.ok) {
      return { error: errorResponse('Usage payload too large', 413) };
    }
    category = 'invalid_utf8';
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(result.bytes);
    category = 'malformed_json';
    const value: unknown = JSON.parse(text);
    return { value };
  } catch {
    logSafely('warn', () => ({ event: 'usage_ingest_rejected', category }));
    return { error: errorResponse('Invalid JSON', 400) };
  }
}

function observeEnqueueCompletion(
  pending: Promise<unknown>,
  sendStartedAt: number,
  usageId: string,
  ctx: ExecutionContext | undefined
): void {
  if (!ctx) return;
  const observed = pending.then(
    () => logCompletion(sendStartedAt, usageId, 'accepted'),
    () => logCompletion(sendStartedAt, usageId, 'unavailable')
  );
  try {
    ctx.waitUntil(observed);
  } catch {
    logSafely('warn', () => ({
      event: 'usage_ingest_enqueue_observation_unregistered',
      usage_id: usageId,
    }));
  }
}

function logCompletion(sendStartedAt: number, usageId: string, outcome: string): void {
  logSafely(outcome === 'accepted' ? 'info' : 'warn', () => ({
    event: 'usage_ingest_enqueue_observed',
    usage_id: usageId,
    outcome,
    send_duration_ms: Math.round(performance.now() - sendStartedAt),
  }));
}

async function handlePublishUsage(
  request: Request,
  env: Env,
  entryAtMs: number,
  ctx?: ExecutionContext
): Promise<Response> {
  const secret = env.USAGE_INGEST_PUBLISH_SECRET;
  if (!secret) return errorResponse('Service unavailable', 503);
  const authorization = request.headers.get('Authorization');
  if (!authorization || !timingSafeEqual(authorization, `Bearer ${secret}`)) {
    return errorResponse('Unauthorized', 401);
  }

  const body = await readUsageBody(request);
  if (body.error) return body.error;
  const result = UsageRecordRequestSchema.safeParse(body.value);
  if (!result.success) {
    logSafely('warn', () => ({
      event: 'usage_ingest_rejected',
      category: 'schema_failure',
      ...schemaRejectionDetails(result.error, body.value),
    }));
    return errorResponse('Invalid usage payload', 400);
  }

  try {
    if (new TextEncoder().encode(JSON.stringify(result.data)).byteLength > MAX_USAGE_BYTES) {
      return errorResponse('Usage payload too large', 413);
    }
  } catch {
    return errorResponse('Usage payload too large', 413);
  }

  const beforeSendAtMs = Date.now();
  logSafely('info', () => ({
    event: 'usage_ingest_enqueue_start',
    usage_id: result.data.core.id,
    publisher_entry_at_ms: entryAtMs,
    before_send_at_ms: beforeSendAtMs,
  }));
  const sendStartedAt = performance.now();
  let sendPromise: Promise<unknown>;
  try {
    sendPromise = env.USAGE_INGEST_QUEUE.send(result.data, { contentType: 'json' });
  } catch {
    logSafely('warn', () => ({
      event: 'usage_ingest_enqueue',
      usage_id: result.data.core.id,
      outcome: 'unavailable',
      after_send_at_ms: Date.now(),
      send_duration_ms: Math.round(performance.now() - sendStartedAt),
    }));
    return errorResponse('Queue unavailable', 503);
  }
  observeEnqueueCompletion(sendPromise, sendStartedAt, result.data.core.id, ctx);
  let response: unknown;
  try {
    response = await sendPromise;
  } catch {
    logSafely('warn', () => ({
      event: 'usage_ingest_enqueue',
      usage_id: result.data.core.id,
      outcome: 'unavailable',
      after_send_at_ms: Date.now(),
      send_duration_ms: Math.round(performance.now() - sendStartedAt),
    }));
    return errorResponse('Queue unavailable', 503);
  }
  const afterSendAtMs = Date.now();
  const sendDurationMs = Math.round(performance.now() - sendStartedAt);
  logSafely('info', () => ({
    event: 'usage_ingest_enqueue',
    usage_id: result.data.core.id,
    outcome: 'accepted',
    publisher_entry_at_ms: entryAtMs,
    before_send_at_ms: beforeSendAtMs,
    after_send_at_ms: afterSendAtMs,
    send_duration_ms: sendDurationMs,
    ...queueMetrics(response),
  }));
  return new Response(null, { status: 202 });
}

export async function handleFetch(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  const entryAtMs = Date.now();
  const pathname = new URL(request.url).pathname;
  if (pathname !== '/usage' && pathname !== '/enkrypt-usage') {
    return new Response('Not Found', { status: 404 });
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  if (pathname === '/enkrypt-usage') return handlePublishEnkryptUsage(request, env, entryAtMs);

  return handlePublishUsage(request, env, entryAtMs, ctx);
}
